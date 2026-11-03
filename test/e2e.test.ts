import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runVdiff } from '../src/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, '../examples/basic');

/** A throwaway git repo with the basic example, sharing this package's react install. */
const fixtureRepo = async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'vdiff-e2e-'));
  await cp(example, repo, { recursive: true, filter: (src) => !src.includes('node_modules') });
  await symlink(path.resolve(here, '../node_modules'), path.join(repo, 'node_modules'), 'dir');
  await writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
  const config = JSON.parse(await readFile(path.join(repo, 'vdiff.config.json'), 'utf8'));
  await writeFile(
    path.join(repo, 'vdiff.config.json'),
    JSON.stringify({ ...config, install: 'true', linkNodeModules: true })
  );
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return { repo, git };
};

test('detects a CSS change in Button and leaves Card untouched', { timeout: 120_000 }, async () => {
  process.env.VDIFF_CACHE_DIR = await mkdtemp(path.join(os.tmpdir(), 'vdiff-cache-'));
  const { repo, git } = await fixtureRepo();
  const css = path.join(repo, 'src/button.css');
  await writeFile(css, (await readFile(css, 'utf8')).replace('#2563eb', '#dc2626'));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'red button');

  const { summary } = await runVdiff({ repo, configFile: path.join(repo, 'vdiff.config.json'), base: 'HEAD~1', head: 'HEAD' });
  const byId = Object.fromEntries(summary.stories.map((s) => [s.id, s.status]));
  assert.deepEqual(byId, {
    'Button/Variants': 'changed',
    'Button/Disabled': 'changed',
    'Card/Basic': 'skipped',
    'Card/WithDate': 'skipped'
  });
});

test('identical refs render identically (determinism)', { timeout: 120_000 }, async () => {
  process.env.VDIFF_CACHE_DIR = await mkdtemp(path.join(os.tmpdir(), 'vdiff-cache-'));
  const { repo } = await fixtureRepo();
  const { summary } = await runVdiff({
    repo,
    configFile: path.join(repo, 'vdiff.config.json'),
    base: 'HEAD',
    head: 'HEAD',
    all: true
  });
  assert.equal(summary.stories.length, 4);
  assert.deepEqual(
    summary.stories.filter((s) => s.status !== 'unchanged').map((s) => `${s.id}: ${s.status} ${s.error ?? ''}`),
    []
  );
});
