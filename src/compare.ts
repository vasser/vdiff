import { readFile, writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface ImageDiff {
  diffPixels: number;
  /** diffPixels / pixels of the larger canvas. */
  ratio: number;
  sizeChanged: boolean;
  width: number;
  height: number;
}

/** Copies an image onto a larger canvas, filling the new area with opaque magenta so it reads as a diff. */
const pad = (img: PNG, width: number, height: number): PNG => {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 0;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
};

export const compareImages = async (
  baseFile: string,
  headFile: string,
  diffFile: string,
  threshold: number
): Promise<ImageDiff> => {
  const [a, b] = await Promise.all([baseFile, headFile].map(async (f) => PNG.sync.read(await readFile(f))));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(pad(a, width, height).data, pad(b, width, height).data, diff.data, width, height, {
    threshold
  });
  if (diffPixels > 0) await writeFile(diffFile, PNG.sync.write(diff));
  return {
    diffPixels,
    ratio: diffPixels / (width * height),
    sizeChanged: a.width !== b.width || a.height !== b.height,
    width,
    height
  };
};
