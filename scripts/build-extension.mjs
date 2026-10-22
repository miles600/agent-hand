import * as esbuild from 'esbuild';
import { mkdir, rm, copyFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

const outdir = 'extension/dist';
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ['extension/src/background.ts'],
  bundle: true,
  outfile: `${outdir}/background.js`,
  format: 'esm',
  target: 'chrome120',
  legalComments: 'none',
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ['extension/src/content.ts'],
  bundle: true,
  outfile: `${outdir}/content.js`,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ['extension/src/options.ts'],
  bundle: true,
  outfile: `${outdir}/options.js`,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ['extension/src/inject.ts'],
  bundle: true,
  outfile: 'dist/inject.js',
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  sourcemap: false,
});

await copyFile('extension/manifest.json', `${outdir}/manifest.json`);
await copyFile('extension/src/options.html', `${outdir}/options.html`);

for (const size of [16, 32, 48, 128]) {
  await writeFile(`${outdir}/icon${size}.png`, icon(size));
}

console.log(`extension built in ${outdir}`);

function icon(size) {
  const arrow = [
    [0.28, 0.18],
    [0.28, 0.74],
    [0.42, 0.58],
    [0.54, 0.84],
    [0.64, 0.78],
    [0.52, 0.52],
    [0.74, 0.5],
  ];
  return png(size, (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    if (!inRoundRect(px, py, size)) return [0, 0, 0, 0];
    const poly = arrow.map(([ax, ay]) => [ax * size, ay * size]);
    if (pointInPoly(px, py, poly)) return [251, 146, 60, 255];
    return [28, 25, 23, 255];
  });
}

function inRoundRect(px, py, size) {
  const margin = size * 0.06;
  const radius = size * 0.22;
  const left = margin;
  const right = size - margin;
  const top = margin;
  const bottom = size - margin;
  if (px < left || px > right || py < top || py > bottom) return false;
  const cx = px < left + radius ? left + radius : px > right - radius ? right - radius : px;
  const cy = py < top + radius ? top + radius : py > bottom - radius ? bottom - radius : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = draw(x, y);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
