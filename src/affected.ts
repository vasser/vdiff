import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Metafile } from 'esbuild';

/** Every input reachable from `entry` in an esbuild metafile (paths relative to the build's working dir). */
export const reachableInputs = (metafile: Metafile, entry: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !metafile.inputs[file]) continue;
    seen.add(file);
    for (const imp of metafile.inputs[file].imports) {
      if (!imp.external) stack.push(imp.path);
    }
  }
  return seen;
};

const hashOf = async (root: string, rel: string, cache: Map<string, string>) => {
  const key = path.join(root, rel);
  let hash = cache.get(key);
  if (hash === undefined) {
    hash = await readFile(key).then(
      (buf) => createHash('sha1').update(buf).digest('hex'),
      () => 'missing'
    );
    cache.set(key, hash);
  }
  return hash;
};

export interface SideGraph {
  root: string;
  metafile: Metafile;
  /** Story file key → story path relative to root. */
  files: Record<string, string>;
}

/**
 * A story file is affected when anything it renders differs between the two sides: its own source,
 * any module in its import graph (which includes prebuilt bundles it imports, so changes behind a
 * webpack/vite build show up through the bundle's content), or any global stylesheet.
 * This is content-based, so it needs no knowledge of how the project builds.
 */
export const affectedStoryFiles = async (base: SideGraph, head: SideGraph, globalFiles: string[]): Promise<Set<string>> => {
  const cache = new Map<string, string>();
  const differs = async (rel: string) => (await hashOf(base.root, rel, cache)) !== (await hashOf(head.root, rel, cache));

  const globalsDiffer = (await Promise.all(globalFiles.map(differs))).some(Boolean);
  const keys = new Set([...Object.keys(base.files), ...Object.keys(head.files)]);
  if (globalsDiffer) return keys;

  const affected = new Set<string>();
  for (const key of keys) {
    const baseFile = base.files[key];
    const headFile = head.files[key];
    if (!baseFile || !headFile) {
      affected.add(key);
      continue;
    }
    const inputs = new Set([...reachableInputs(base.metafile, baseFile), ...reachableInputs(head.metafile, headFile)]);
    for (const rel of inputs) {
      // Synthetic esbuild namespaces (e.g. "<stdin>") have no file behind them.
      // Dependencies are covered by the lockfile, which callers pass as a global file.
      if (rel.includes(':') || rel.startsWith('<') || rel.includes('node_modules/')) continue;
      if (await differs(rel)) {
        affected.add(key);
        break;
      }
    }
  }
  return affected;
};
