import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Metafile } from 'esbuild';
import { affectedStoryFiles, reachableInputs } from '../src/affected.js';

const meta = (graph: Record<string, string[]>): Metafile => ({
  inputs: Object.fromEntries(
    Object.entries(graph).map(([file, imports]) => [
      file,
      { bytes: 0, imports: imports.map((p) => ({ path: p, kind: 'import-statement' as const })) }
    ])
  ),
  outputs: {}
});

const graph = {
  'stories/A.jsx': ['src/a.jsx'],
  'src/a.jsx': ['src/shared.js'],
  'src/shared.js': [],
  'stories/B.jsx': ['src/b.jsx'],
  'src/b.jsx': []
};

const side = async (files: Record<string, string>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vdiff-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return { root, metafile: meta(graph), files: { A: 'stories/A.jsx', B: 'stories/B.jsx' } };
};

const sources = {
  'stories/A.jsx': 'a-story',
  'src/a.jsx': 'a',
  'src/shared.js': 'shared',
  'stories/B.jsx': 'b-story',
  'src/b.jsx': 'b',
  'global.css': 'body{}'
};

test('reachableInputs walks the import graph', () => {
  assert.deepEqual([...reachableInputs(meta(graph), 'stories/A.jsx')].sort(), [
    'src/a.jsx',
    'src/shared.js',
    'stories/A.jsx'
  ]);
});

test('only stories that reach a changed file are affected', async () => {
  const base = await side(sources);
  const head = await side({ ...sources, 'src/shared.js': 'shared v2' });
  assert.deepEqual([...(await affectedStoryFiles(base, head, ['global.css']))], ['A']);
});

test('a changed global file affects every story', async () => {
  const base = await side(sources);
  const head = await side({ ...sources, 'global.css': 'body{color:red}' });
  assert.deepEqual([...(await affectedStoryFiles(base, head, ['global.css']))].sort(), ['A', 'B']);
});
