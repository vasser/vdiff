import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { affectedStoryFiles } from './affected.js';
import { captureStories, listStories, safeName, type Shot } from './capture.js';
import { changedFiles, checkout, prepare } from './checkout.js';
import { compareImages } from './compare.js';
import { loadConfig, optionsFor, type Config } from './config.js';
import { log } from './exec.js';
import { buildHarness } from './harness/build.js';
import { serve } from './harness/server.js';
import { summarize, writeReport, type StoryResult, type Summary } from './report/write.js';

export interface RunOptions {
  repo: string;
  base: string;
  head: string;
  configFile: string;
  /** Report directory; defaults to <cache>/report. */
  out?: string;
  /** Render every story, not only the ones whose inputs changed. */
  all?: boolean;
  /** Reinstall and rebuild even when a cached build exists. */
  force?: boolean;
  /** Only render stories whose id matches one of these globs-free prefixes / exact ids. */
  only?: string[];
}

export const cacheDirFor = (repo: string) =>
  path.join(
    process.env.VDIFF_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'vdiff'),
    `${path.basename(repo)}-${createHash('sha1').update(repo).digest('hex').slice(0, 8)}`
  );

const fileKey = (id: string) => id.slice(0, id.lastIndexOf('/'));

/** Pairs base/head screenshots into report entries, writing diff images for changed ones. */
export const diffShots = async (
  ids: string[],
  baseShots: Map<string, Shot>,
  headShots: Map<string, Shot>,
  reportDir: string,
  config: Pick<Config, 'threshold' | 'maxDiffRatio'>
): Promise<StoryResult[]> => {
  await mkdir(path.join(reportDir, 'diff'), { recursive: true });
  const rel = (file?: string) => (file ? path.relative(reportDir, file).split(path.sep).join('/') : undefined);
  const results: StoryResult[] = [];
  for (const id of ids) {
    const b = baseShots.get(id);
    const h = headShots.get(id);
    const warnings = [...(b?.warnings ?? []).map((w) => `base ${w}`), ...(h?.warnings ?? []).map((w) => `head ${w}`)];
    const common = { id, base: rel(b?.file), head: rel(h?.file), warnings };
    if (h?.error || b?.error) {
      const error = [h?.error && `head: ${h.error}`, b?.error && `base: ${b.error}`].filter(Boolean).join('\n\n');
      results.push({ ...common, status: 'error', error });
    } else if (!b && h?.file) {
      results.push({ ...common, status: 'added' });
    } else if (b?.file && !h) {
      results.push({ ...common, status: 'removed' });
    } else if (b?.file && h?.file) {
      const diffFile = path.join(reportDir, 'diff', `${safeName(id)}.png`);
      const d = await compareImages(b.file, h.file, diffFile, config.threshold);
      const changed = d.sizeChanged || (d.diffPixels > 0 && d.ratio > config.maxDiffRatio);
      results.push({
        ...common,
        status: changed ? 'changed' : 'unchanged',
        diff: changed ? rel(diffFile) : undefined,
        diffPixels: d.diffPixels,
        ratio: d.ratio,
        sizeChanged: d.sizeChanged
      });
    }
  }
  return results;
};

export const runVdiff = async (opts: RunOptions): Promise<{ summary: Summary; reportFile: string }> => {
  const repo = path.resolve(opts.repo);
  const cacheDir = cacheDirFor(repo);
  const reportDir = path.resolve(opts.out ?? path.join(cacheDir, 'report'));
  const logFile = path.join(cacheDir, 'build.log');
  await mkdir(cacheDir, { recursive: true });
  await rm(reportDir, { recursive: true, force: true });
  await rm(logFile, { force: true });
  await mkdir(reportDir, { recursive: true });

  const config = await loadConfig(path.resolve(opts.configFile), path.join(cacheDir, 'config'));
  const base = await checkout(repo, opts.base, 'base', cacheDir);
  const head = await checkout(repo, opts.head, 'head', cacheDir);
  const sideInfo = (s: typeof base) => ({ ref: s.ref, sha: s.sha });

  const changed = await changedFiles(repo, base, head);
  log(`${changed.length} file(s) changed between ${opts.base} and ${opts.head}`);
  if (changed.length === 0 && !opts.all) {
    const summary = summarize(sideInfo(base), sideInfo(head), 0, []);
    return { summary, reportFile: await writeReport(reportDir, summary) };
  }

  for (const side of [base, head]) await prepare(repo, side, config, logFile, !!opts.force);

  const [baseHarness, headHarness] = await Promise.all(
    [base, head].map((side) => buildHarness(side.root, config, path.join(cacheDir, 'harness', side.name)))
  );

  const globalFiles = [...config.css, config.lockfile];
  const affected = opts.all
    ? null
    : await affectedStoryFiles(
        { root: base.root, metafile: baseHarness.metafile, files: baseHarness.files },
        { root: head.root, metafile: headHarness.metafile, files: headHarness.files },
        globalFiles
      );

  const servers: Server[] = [];
  const browser = await chromium.launch();
  try {
    const [baseSrv, headSrv] = await Promise.all([
      serve(baseHarness.dir, base.root),
      serve(headHarness.dir, head.root)
    ]);
    servers.push(baseSrv.server, headSrv.server);

    const [baseIds, headIds] = await Promise.all([
      listStories(browser, baseSrv.url, config),
      listStories(browser, headSrv.url, config)
    ]);
    const all = [...new Set([...baseIds, ...headIds])].sort();
    const wanted = (id: string) =>
      !optionsFor(config, id).skip && (!opts.only?.length || opts.only.some((o) => id === o || id.startsWith(o)));
    const selected = all.filter((id) => wanted(id) && (!affected || affected.has(fileKey(id))));
    const skipped = all.filter((id) => wanted(id) && !selected.includes(id));
    log(`${all.length} stories, rendering ${selected.length}${affected ? ` (${skipped.length} not affected)` : ''}`);

    const capture = async (name: string, url: string, ids: string[]) => {
      const targets = ids.filter((id) => selected.includes(id));
      let last = 0;
      const shots = await captureStories(browser, url, targets, config, path.join(reportDir, name), (done) => {
        const pct = Math.floor((done / targets.length) * 10);
        if (pct > last || done === targets.length) {
          last = pct;
          log(`${name}: ${done}/${targets.length} captured`);
        }
      });
      return shots;
    };
    const baseShots = await capture('base', baseSrv.url, baseIds);
    const headShots = await capture('head', headSrv.url, headIds);

    const results = await diffShots(selected, baseShots, headShots, reportDir, config);
    results.push(...skipped.map((id): StoryResult => ({ id, status: 'skipped' })));
    const summary = summarize(sideInfo(base), sideInfo(head), changed.length, results);
    return { summary, reportFile: await writeReport(reportDir, summary) };
  } finally {
    await browser.close();
    for (const s of servers) s.close();
  }
};

/** Diffs two folders of PNGs (matched by file name) without building anything. */
export const compareDirs = async (
  baseDir: string,
  headDir: string,
  out: string,
  config: Pick<Config, 'threshold' | 'maxDiffRatio'>
): Promise<{ summary: Summary; reportFile: string }> => {
  const reportDir = path.resolve(out);
  await rm(reportDir, { recursive: true, force: true });
  const shots = async (dir: string, name: string) => {
    const target = path.join(reportDir, name);
    await mkdir(target, { recursive: true });
    const map = new Map<string, Shot>();
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.png'))) {
      await copyFile(path.join(dir, f), path.join(target, f));
      map.set(f.slice(0, -4), { id: f.slice(0, -4), file: path.join(target, f), warnings: [] });
    }
    return map;
  };
  const b = await shots(baseDir, 'base');
  const h = await shots(headDir, 'head');
  const ids = [...new Set([...b.keys(), ...h.keys()])].sort();
  const results = await diffShots(ids, b, h, reportDir, config);
  const summary = summarize({ ref: baseDir, sha: '' }, { ref: headDir, sha: '' }, 0, results);
  return { summary, reportFile: await writeReport(reportDir, summary) };
};
