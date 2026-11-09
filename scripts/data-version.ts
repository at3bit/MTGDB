// Writes public/data/version.json: a content hash for each data file of this
// build. The app fetches version.json fresh, then asks for each file by its
// hash (cards.json?v=<hash>) and checks what it got. So a phone never mixes a
// cached file from one deployment with a file from another (each deployment
// rebuilds the catalogue from Scryfall, and the printings change daily).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_FILES = ['cards.json', 'fingerprints.bin', 'baselines.bin'];

/** Same as the app's check: the first 8 bytes of the SHA-256, in hex. */
export const contentHash = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

export function writeDataVersion(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of DATA_FILES) {
    const p = join(dir, name);
    if (existsSync(p)) files[name] = contentHash(readFileSync(p));
  }
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ built: new Date().toISOString(), files }));
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
  const files = writeDataVersion(dir);
  console.log(`Wrote version.json: ${Object.entries(files).map(([n, h]) => `${n} ${h}`).join(', ')}`);
}
