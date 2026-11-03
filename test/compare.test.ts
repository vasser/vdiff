import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { compareImages } from '../src/compare.js';

const png = async (dir: string, name: string, w: number, h: number, paint?: (x: number, y: number) => number[]) => {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      img.data.set([r, g, b, 255], (y * w + x) * 4);
    }
  const file = path.join(dir, name);
  await writeFile(file, PNG.sync.write(img));
  return file;
};

test('identical images have no diff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-'));
  const a = await png(dir, 'a.png', 20, 10);
  const b = await png(dir, 'b.png', 20, 10);
  const d = await compareImages(a, b, path.join(dir, 'd.png'), 0.1);
  assert.equal(d.diffPixels, 0);
  assert.equal(d.sizeChanged, false);
});

test('changed pixels are counted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-'));
  const a = await png(dir, 'a.png', 20, 10);
  const b = await png(dir, 'b.png', 20, 10, (x, y) => (x < 5 && y < 2 ? [0, 0, 0] : [255, 255, 255]));
  const d = await compareImages(a, b, path.join(dir, 'd.png'), 0.1);
  assert.equal(d.diffPixels, 10);
  assert.equal(d.ratio, 10 / 200);
});

test('size changes are reported and the extra area counts as diff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-'));
  const a = await png(dir, 'a.png', 20, 10);
  const b = await png(dir, 'b.png', 20, 12);
  const d = await compareImages(a, b, path.join(dir, 'd.png'), 0.1);
  assert.equal(d.sizeChanged, true);
  assert.equal(d.height, 12);
  assert.equal(d.diffPixels, 40);
});
