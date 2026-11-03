import { glob, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, type Metafile } from 'esbuild';
import type { Config } from '../config.js';
import { RUNTIME } from './runtime.js';

export interface Harness {
  dir: string;
  /** Story file key ("Button") → path relative to the side root. */
  files: Record<string, string>;
  metafile: Metafile;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export const findStoryFiles = async (root: string, patterns: string | string[]): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const found: string[] = [];
  for await (const file of glob(patterns, { cwd: root, exclude: (f) => f.includes('node_modules') })) {
    found.push(toPosix(file));
  }
  for (const rel of found.sort()) {
    let key = path.basename(rel).replace(/\.(stories|story|preview)?\.?[cm]?[jt]sx?$/, '');
    // Two files with the same base name: fall back to the relative path as the key.
    if (files[key]) key = rel.replace(/\.[cm]?[jt]sx?$/, '');
    files[key] = rel;
  }
  return files;
};

const ASSET_LOADERS = Object.fromEntries(
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot'].map((ext) => [ext, 'dataurl'])
) as Record<string, 'dataurl'>;

/**
 * Bundles every story module of one side into a static page. Paths in the metafile are relative to
 * the side root, so the dependency graphs of base and head can be compared file by file.
 */
export const buildHarness = async (root: string, config: Config, outDir: string): Promise<Harness> => {
  const files = await findStoryFiles(root, config.stories);
  if (Object.keys(files).length === 0) {
    throw new Error(`No story files match ${JSON.stringify(config.stories)} in ${root}`);
  }

  const imports = Object.values(files)
    .map((rel, i) => `import * as m${i} from ${JSON.stringify('./' + rel)};`)
    .join('\n');
  const table = Object.keys(files)
    .map((key, i) => `${JSON.stringify(key)}: m${i}`)
    .join(',\n  ');
  const wrapper = config.wrapper
    ? `import Wrapper from ${JSON.stringify(path.resolve(config.configDir, config.wrapper))};`
    : 'const Wrapper = ({ children }) => children;';
  const entry = `${imports}\n${wrapper}\nimport * as React from 'react';\nimport { createRoot } from 'react-dom/client';\nconst files = {\n  ${table}\n};\n${RUNTIME}`;

  const alias: Record<string, string> = {};
  if (config.bundle) alias[config.bundle.importName] = path.resolve(root, config.bundle.js);
  for (const [name, target] of Object.entries(config.alias)) alias[name] = path.resolve(root, target);

  await mkdir(outDir, { recursive: true });
  const result = await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'vdiff-entry.jsx', loader: 'jsx' },
    absWorkingDir: root,
    outfile: path.join(outDir, 'harness.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    alias,
    // Lets files outside the repo (e.g. a wrapper next to the config) import the repo's dependencies.
    nodePaths: [path.join(root, 'node_modules')],
    loader: ASSET_LOADERS,
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'globalThis.process ??= { env: {} };' },
    metafile: true,
    logLevel: 'error'
  });

  const hasCss = Object.keys(result.metafile.outputs).some((o) => o.endsWith('.css'));
  const links = [...config.css.map((c) => '/' + toPosix(c)), ...(hasCss ? ['/__vdiff/harness.css'] : [])]
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join('\n    ');
  await writeFile(
    path.join(outDir, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; background: #fff; } #root { display: flow-root; padding: 16px; }</style>
    ${links}
  </head>
  <body>
    <div id="root"></div>
    <script src="/__vdiff/harness.js"></script>
  </body>
</html>
`
  );

  return { dir: outDir, files, metafile: result.metafile };
};
