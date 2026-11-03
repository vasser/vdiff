#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WORKING_TREE } from './checkout.js';
import { findConfig } from './config.js';
import { git, log } from './exec.js';
import { cacheDirFor, compareDirs, runVdiff } from './run.js';
import type { Summary } from './report/write.js';

const HELP = `vdiff - visual diffs of component stories between two git refs

Usage:
  vdiff run [options]              build, render and diff stories at --base and --head
  vdiff compare <baseDir> <headDir> [--out dir]   diff two folders of PNGs
  vdiff clean [--repo path]        remove cached worktrees and reports for a repo

Options for run:
  --repo <path>      repository to test (default: current directory)
  --config <file>    config file (default: vdiff.config.{ts,mts,js,mjs,json} in the repo)
  --base <ref>       ref to compare against (default: merge-base of HEAD and origin/main)
  --head <ref>       ref with the changes; "." = working tree incl. uncommitted changes (default: ".")
  --out <dir>        report directory (default: ~/.cache/vdiff/<repo>/report)
  --all              render every story, not only the ones whose inputs changed
  --only <id>        only stories whose id starts with this (repeatable), e.g. --only Button
  --force            reinstall and rebuild even if a cached build exists
  --exit-zero        exit 0 even when there are visual changes

Exit codes: 0 no changes, 1 visual changes or story errors, 2 failure.
`;

const printSummary = (summary: Summary, reportFile: string) => {
  const c = summary.counts;
  const parts = [
    `${c.changed} changed`,
    `${c.added} new`,
    `${c.removed} removed`,
    `${c.error} errors`,
    `${c.unchanged} unchanged`,
    c.skipped ? `${c.skipped} not affected` : ''
  ].filter(Boolean);
  log(parts.join(', '));
  for (const s of summary.stories.filter((s) => ['changed', 'added', 'removed', 'error'].includes(s.status))) {
    const detail = s.status === 'changed' ? ` (${((s.ratio ?? 0) * 100).toFixed(2)}%${s.sizeChanged ? ', size' : ''})` : '';
    process.stderr.write(`  ${s.status.padEnd(8)} ${s.id}${detail}\n`);
  }
  log(`report: ${reportFile}`);
};

const defaultBase = async (repo: string) => {
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      return await git(repo, 'merge-base', 'HEAD', candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('Could not find a default base (origin/main, main, ...). Pass --base.');
};

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      config: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      out: { type: 'string' },
      all: { type: 'boolean' },
      only: { type: 'string', multiple: true },
      force: { type: 'boolean' },
      threshold: { type: 'string' },
      'exit-zero': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }

  const repo = path.resolve(values.repo ?? '.');
  const fail = (summary: Summary) =>
    !values['exit-zero'] && summary.counts.changed + summary.counts.added + summary.counts.removed + summary.counts.error > 0
      ? 1
      : 0;

  if (command === 'run') {
    const configFile = values.config ?? (await findConfig(repo));
    if (!configFile) throw new Error(`No --config given and no vdiff.config.* in ${repo}`);
    const { summary, reportFile } = await runVdiff({
      repo,
      configFile,
      base: values.base ?? (await defaultBase(repo)),
      head: values.head ?? WORKING_TREE,
      out: values.out,
      all: values.all,
      force: values.force,
      only: values.only
    });
    printSummary(summary, reportFile);
    return fail(summary);
  }

  if (command === 'compare') {
    if (rest.length !== 2) throw new Error('Usage: vdiff compare <baseDir> <headDir> [--out dir]');
    const { summary, reportFile } = await compareDirs(rest[0], rest[1], values.out ?? 'vdiff-report', {
      threshold: values.threshold ? Number(values.threshold) : 0.1,
      maxDiffRatio: 0
    });
    printSummary(summary, reportFile);
    return fail(summary);
  }

  if (command === 'clean') {
    const dir = cacheDirFor(repo);
    await rm(dir, { recursive: true, force: true });
    await git(repo, 'worktree', 'prune');
    log(`removed ${dir}`);
    return 0;
  }

  throw new Error(`Unknown command "${command}". See vdiff --help.`);
};

main().then(
  (code) => process.exit(code),
  (e) => {
    log(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
);
