// The blank-card test against real card images: how flat and bright can a real card look?
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { blankFraction } from '../src/core/recognize.ts';

const dirs = ['data-cache/scans', 'data-cache/scans-large'];
const scores: { f: number; file: string }[] = [];
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
    const { data, info } = await sharp(`${dir}/${f}`).resize(48, 67, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    scores.push({ f: blankFraction({ width: info.width, height: info.height, data: Float32Array.from(data) }), file: `${dir}/${f}` });
  }
}
scores.sort((a, b) => b.f - a.f);
console.log(`${scores.length} real card images; flattest: ${scores.slice(0, 5).map((s) => `${s.f.toFixed(2)} (${s.file.split('/').pop()})`).join(', ')}`);
console.log(`above 0.2: ${scores.filter((s) => s.f > 0.2).length}, above 0.35: ${scores.filter((s) => s.f > 0.35).length}`);
