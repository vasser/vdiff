import { createHash } from 'node:crypto';
import { access, lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { git, log, shell } from './exec.js';

/** The working tree itself (uncommitted changes included) rather than a commit. */
export const WORKING_TREE = '.';

export interface Side {
  name: 'base' | 'head';
  ref: string;
  /** Commit SHA, or "working-tree" for ref ".". */
  sha: string;
  /** Directory the stories are built and served from. */
  root: string;
}

const fileExists = (p: string) =>
  access(p).then(
    () => true,
    () => false
  );

const hashFile = async (p: string) =>
  (await fileExists(p)) ? createHash('sha1').update(await readFile(p)).digest('hex') : 'none';

export const resolveRef = (repo: string, ref: string) => git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);

/** Checks the ref out into a reusable git worktree (or uses the repo itself for "."). */
export const checkout = async (repo: string, ref: string, name: Side['name'], cacheDir: string): Promise<Side> => {
  if (ref === WORKING_TREE) return { name, ref, sha: 'working-tree', root: repo };

  const sha = await resolveRef(repo, ref);
  const root = path.join(cacheDir, 'worktrees', name);
  if (await fileExists(path.join(root, '.git'))) {
    await git(root, 'checkout', '--quiet', '--force', '--detach', sha);
  } else {
    await git(repo, 'worktree', 'prune');
    await git(repo, 'worktree', 'add', '--force', '--detach', root, sha);
  }
  log(`${name}: ${ref} @ ${sha.slice(0, 10)} → ${root}`);
  return { name, ref, sha, root };
};

const MARKER = '.vdiff-state.json';

interface BuildState {
  sha: string;
  lockfile: string;
  build?: string;
}

const readState = async (root: string): Promise<Partial<BuildState>> => {
  try {
    return JSON.parse(await readFile(path.join(root, MARKER), 'utf8'));
  } catch {
    return {};
  }
};

/**
 * Installs dependencies and runs the build for a side. Worktrees remember what they were built
 * from, so re-running against the same commit (e.g. the base branch) skips both steps.
 */
export const prepare = async (repo: string, side: Side, config: Config, logFile: string, force: boolean) => {
  const isWorkingTree = side.sha === 'working-tree';
  const lockfile = await hashFile(path.join(side.root, config.lockfile));
  const state = isWorkingTree ? {} : await readState(side.root);
  // Lets install/build commands reference files that live next to the config, outside the repo.
  const env = { VDIFF_CONFIG_DIR: config.configDir, VDIFF_SIDE: side.name, VDIFF_REPO: repo };

  if (isWorkingTree) {
    // The working tree is the user's own checkout: install only if it has never been installed.
    if (!(await fileExists(path.join(side.root, 'node_modules')))) {
      log(`${side.name}: no node_modules, running ${config.install}`);
      await shell(config.install, side.root, logFile, env);
    }
  } else if (force || state.lockfile !== lockfile) {
    const nodeModules = path.join(side.root, 'node_modules');
    const repoLockfile = await hashFile(path.join(repo, config.lockfile));
    const canLink =
      config.linkNodeModules && lockfile === repoLockfile && (await fileExists(path.join(repo, 'node_modules')));
    const isLink = await lstat(nodeModules).then(
      (s) => s.isSymbolicLink(),
      () => false
    );
    if (canLink) {
      if (!isLink) {
        if (await fileExists(nodeModules)) {
          log(`${side.name}: node_modules already installed, keeping it`);
        } else {
          log(`${side.name}: linking node_modules from ${repo}`);
          await symlink(path.join(repo, 'node_modules'), nodeModules, 'dir');
        }
      }
    } else {
      log(`${side.name}: ${config.install}`);
      await shell(config.install, side.root, logFile, env);
    }
  }

  const needsBuild = isWorkingTree || force || state.sha !== side.sha || state.build !== config.build;
  if (config.build && needsBuild) {
    log(`${side.name}: building (${config.build})`);
    const started = Date.now();
    await shell(config.build, side.root, logFile, env);
    log(`${side.name}: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else if (config.build) {
    log(`${side.name}: build cached for ${side.sha.slice(0, 10)}`);
  }

  if (!isWorkingTree) {
    const next: BuildState = { sha: side.sha, lockfile, build: config.build };
    await writeFile(path.join(side.root, MARKER), JSON.stringify(next));
  }
};

/** Files that differ between the two sides (committed changes, plus uncommitted ones when head is "."). */
export const changedFiles = async (repo: string, base: Side, head: Side): Promise<string[]> => {
  const args =
    head.sha === 'working-tree' ? ['diff', '--name-only', base.sha] : ['diff', '--name-only', base.sha, head.sha];
  const out = await git(repo, ...args);
  const files = out ? out.split('\n') : [];
  if (head.sha === 'working-tree') {
    const untracked = await git(repo, 'ls-files', '--others', '--exclude-standard');
    if (untracked) files.push(...untracked.split('\n'));
  }
  return files;
};
