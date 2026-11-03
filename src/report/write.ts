import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Status = 'changed' | 'added' | 'removed' | 'error' | 'unchanged' | 'skipped';

export interface StoryResult {
  id: string;
  status: Status;
  /** Image paths relative to the report directory. */
  base?: string;
  head?: string;
  diff?: string;
  diffPixels?: number;
  ratio?: number;
  sizeChanged?: boolean;
  error?: string;
  warnings?: string[];
}

export interface Summary {
  createdAt: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  changedFiles: number;
  counts: Record<Status, number>;
  stories: StoryResult[];
}

const ORDER: Status[] = ['changed', 'added', 'removed', 'error', 'unchanged', 'skipped'];

export const summarize = (
  base: Summary['base'],
  head: Summary['head'],
  changedFiles: number,
  stories: StoryResult[]
): Summary => {
  const sorted = [...stories].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id)
  );
  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<Status, number>;
  for (const s of sorted) counts[s.status]++;
  return { createdAt: new Date().toISOString(), base, head, changedFiles, counts, stories: sorted };
};

const templatePath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html');

/** Writes index.html (self-contained apart from the PNGs next to it) and summary.json. */
export const writeReport = async (dir: string, summary: Summary) => {
  const template = await readFile(templatePath(), 'utf8');
  // Escape "<" so story ids or error text can't close the JSON <script> block.
  const json = JSON.stringify(summary).replace(/</g, '\\u003c');
  await writeFile(path.join(dir, 'index.html'), template.replace('/*__VDIFF_DATA__*/', () => json));
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return path.join(dir, 'index.html');
};
