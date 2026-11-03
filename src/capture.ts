import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { optionsFor, type Config } from './config.js';

export interface Shot {
  id: string;
  file?: string;
  error?: string;
  /** Console errors and page errors seen while rendering; reported but not fatal. */
  warnings: string[];
}

const FREEZE_CSS = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
  transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important;
}`;

export const safeName = (id: string) => id.replace(/[^\w.-]+/g, '_');

const newContext = async (browser: Browser, serverUrl: string, config: Config): Promise<BrowserContext> => {
  const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light' });
  // The clock is context-wide in Playwright; setting it per page races between parallel pages.
  await context.clock.setFixedTime(new Date(config.now));
  const local = new URL(serverUrl).host;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.host === local || config.allowHosts.includes(url.hostname)) {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
  return context;
};

export const listStories = async (browser: Browser, serverUrl: string, config: Config): Promise<string[]> => {
  const context = await newContext(browser, serverUrl, config);
  try {
    const page = await context.newPage();
    await page.goto(serverUrl + '/');
    await page.waitForFunction(() => (window as any).__vdiffReady === true);
    return await page.evaluate(() => (window as any).__vdiffStories as string[]);
  } finally {
    await context.close();
  }
};

/** Screenshots each story in its own page, `config.workers` at a time. */
export const captureStories = async (
  browser: Browser,
  serverUrl: string,
  ids: string[],
  config: Config,
  outDir: string,
  onProgress?: (done: number) => void
): Promise<Map<string, Shot>> => {
  await mkdir(outDir, { recursive: true });
  const context = await newContext(browser, serverUrl, config);
  const shots = new Map<string, Shot>();
  const queue = [...ids];
  let done = 0;

  const captureOne = async (id: string): Promise<Shot> => {
    const options = optionsFor(config, id);
    const warnings: string[] = [];
    const page = await context.newPage();
    page.on('pageerror', (e) => warnings.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') warnings.push(`console: ${m.text()}`);
    });
    try {
      await page.setViewportSize(options.viewport);
      await page.goto(`${serverUrl}/?story=${encodeURIComponent(id)}`);
      await page.waitForFunction(() => (window as any).__vdiffReady === true, null, { timeout: 15_000 });
      await page.addStyleTag({ content: FREEZE_CSS });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r))))
        );
      });
      if (options.delay) await page.waitForTimeout(options.delay);

      const renderError = await page.evaluate(() => (window as any).__vdiffError as string | undefined);
      if (renderError) return { id, error: renderError, warnings };

      const file = path.join(outDir, `${safeName(id)}.png`);
      const root = page.locator('#root');
      const box = await root.boundingBox();
      // Overlay-only stories (modals, drawers) leave #root empty apart from its padding.
      if (options.fullPage || !box || box.height <= 32) {
        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      } else {
        await root.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      }
      return { id, file, warnings };
    } catch (e) {
      return { id, error: e instanceof Error ? e.message : String(e), warnings };
    } finally {
      await page.close();
    }
  };

  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      let shot = await captureOne(id);
      // One retry absorbs transient failures (crashed renderer, slow first load) without hiding real errors.
      if (shot.error) shot = await captureOne(id);
      shots.set(id, shot);
      onProgress?.(++done);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(config.workers, ids.length) }, worker));
  } finally {
    await context.close();
  }
  return shots;
};
