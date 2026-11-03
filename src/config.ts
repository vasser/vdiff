import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';

const viewportSchema = z.union([
  z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  z.string().regex(/^\d+x\d+$/, 'expected "<width>x<height>"')
]);

const storyOptionsSchema = z.object({
  viewport: viewportSchema.optional(),
  /** Extra wait after the story reports ready, in ms (mount effects, hover timers). */
  delay: z.number().int().nonnegative().optional(),
  /** Screenshot the whole viewport instead of the story root. */
  fullPage: z.boolean().optional(),
  skip: z.boolean().optional()
});

const configSchema = z.object({
  /** Shell command that installs dependencies in a checkout. Skipped when node_modules is linked. */
  install: z.string().default('npm ci'),
  /**
   * Symlink node_modules from the repo's own working tree into checkouts whose lockfile is
   * identical to it. Saves a full install per ref (and private-registry auth) in local runs.
   */
  linkNodeModules: z.boolean().default(false),
  lockfile: z.string().default('package-lock.json'),
  /** Shell command that builds whatever the stories import. Optional when stories import source directly. */
  build: z.string().optional(),
  /** A prebuilt library that stories import under a package name (e.g. a webpack library build). */
  bundle: z
    .object({
      js: z.string(),
      importName: z.string()
    })
    .optional(),
  /** Stylesheets injected into every story page, relative to the repo root. */
  css: z.array(z.string()).default([]),
  /** Glob (relative to the repo root) of story modules. Each named export is a story. */
  stories: z.union([z.string(), z.array(z.string())]),
  viewport: viewportSchema.default({ width: 1024, height: 768 }),
  delay: z.number().int().nonnegative().default(150),
  /** Per-story options keyed by story file name ("Button") or story id ("Button/Sizes"). */
  overrides: z.record(z.string(), storyOptionsSchema).default({}),
  /** Hosts the page may load from besides the local server (fonts, icon CDNs). Everything else is blocked. */
  allowHosts: z.array(z.string()).default([]),
  /** Fixed Date.now() for every story, so dates render the same on both sides. */
  now: z.string().default('2024-01-15T10:00:00Z'),
  /** pixelmatch colour threshold (0-1); lower is stricter. */
  threshold: z.number().min(0).max(1).default(0.1),
  /** Stories whose changed-pixel ratio is at or below this count as unchanged. */
  maxDiffRatio: z.number().min(0).max(1).default(0),
  /** Parallel browser pages. */
  workers: z.number().int().positive().default(6),
  /**
   * Module whose default export wraps every story, like a Storybook decorator: receives
   * `{ children, id }`. Use it for providers (router, theme, store). Relative to the config file.
   */
  wrapper: z.string().optional(),
  /** Extra esbuild aliases for the story harness (module name → path relative to repo root). */
  alias: z.record(z.string(), z.string()).default({})
});

export type Config = z.infer<typeof configSchema> & { configDir: string };
export type StoryOptions = z.infer<typeof storyOptionsSchema>;
export type Viewport = { width: number; height: number };
export type ConfigInput = z.input<typeof configSchema>;

/** Identity helper for typed config files: `export default defineConfig({...})`. */
export const defineConfig = (config: ConfigInput): ConfigInput => config;

export const parseViewport = (v: z.infer<typeof viewportSchema>): Viewport => {
  if (typeof v !== 'string') return v;
  const [width, height] = v.split('x').map(Number);
  return { width, height };
};

const CONFIG_NAMES = ['vdiff.config.ts', 'vdiff.config.mts', 'vdiff.config.js', 'vdiff.config.mjs', 'vdiff.config.json'];

const exists = (file: string) =>
  readFile(file).then(
    () => true,
    () => false
  );

export const findConfig = async (repo: string): Promise<string | undefined> => {
  for (const name of CONFIG_NAMES) {
    const file = path.join(repo, name);
    if (await exists(file)) return file;
  }
  return undefined;
};

/** Loads a .json/.js/.mjs/.ts config. TS configs are bundled with esbuild, so no loader is needed. */
export const loadConfig = async (file: string, cacheDir: string): Promise<Config> => {
  let raw: unknown;
  if (file.endsWith('.json')) {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } else {
    await mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `config-${Date.now()}.mjs`);
    await build({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent'
    });
    const mod = await import(pathToFileURL(outfile).href);
    raw = mod.default ?? mod;
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config ${file}:\n${z.prettifyError(result.error)}`);
  }
  return { ...result.data, configDir: path.dirname(path.resolve(file)) };
};

export const optionsFor = (config: Config, id: string): StoryOptions & { viewport: Viewport; delay: number } => {
  const file = id.slice(0, id.lastIndexOf('/'));
  const merged = { ...config.overrides[file], ...config.overrides[id] };
  return {
    ...merged,
    viewport: parseViewport(merged.viewport ?? config.viewport),
    delay: merged.delay ?? config.delay
  };
};
