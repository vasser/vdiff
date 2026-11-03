import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export const log = (msg: string) => process.stderr.write(`[vdiff] ${msg}\n`);

/** Runs a command and returns trimmed stdout; throws with stderr on failure. */
export const run = (cmd: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')} failed (${code}):\n${err.trim()}`))
    );
  });

export const git = (cwd: string, ...args: string[]) => run('git', args, cwd);

/** Runs a shell command, appending its output to a log file. The tail of the log is included on failure. */
export const shell = (
  command: string,
  cwd: string,
  logFile: string,
  env: Record<string, string> = {}
): Promise<void> =>
  new Promise((resolve, reject) => {
    const logStream = createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n$ ${command}\n`);
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env } });
    let tail = '';
    const onData = (d: Buffer) => {
      logStream.write(d);
      tail = (tail + d.toString()).slice(-4000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      logStream.end();
      if (code === 0) resolve();
      else reject(new Error(`"${command}" failed in ${cwd} (exit ${code}). Full log: ${logFile}\n…${tail}`));
    });
  });
