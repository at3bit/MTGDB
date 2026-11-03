// Copies the OCR engine (Tesseract.js worker, WASM core and English model) into
// public/vendor so the app serves them itself instead of pulling from a CDN.
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor', 'tesseract');

if (!existsSync(join(nm, 'tesseract.js'))) {
  console.log('copy-vendor: tesseract.js not installed yet, skipping');
  process.exit(0);
}
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });
cpSync(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
for (const f of readdirSync(join(nm, 'tesseract.js-core'))) {
  if (/^tesseract-core.*\.wasm\.js$/.test(f)) cpSync(join(nm, 'tesseract.js-core', f), join(out, 'core', f));
}
// "best_int" is the more accurate integer-quantised LSTM model.
cpSync(join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz'));
console.log('copy-vendor: Tesseract assets copied to public/vendor/tesseract');
