import { createReadStream } from 'node:fs';

/** Streams the top-level objects of a huge JSON array without loading it all into one string. */
export async function* streamArray(path: string): AsyncGenerator<unknown> {
  let depth = 0, inStr = false, esc = false, buf = '', started = false;
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    let start = 0;
    const s = chunk as string;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') {
        if (depth === 0) { started = true; start = i; buf = ''; }
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && started) {
          yield JSON.parse(buf + s.slice(start, i + 1));
          started = false;
          buf = '';
        }
      }
    }
    if (started) buf += s.slice(start);
  }
}


/**
 * Streams the entries of a huge JSON object one level down, e.g. every
 * `[key, value]` of `{"meta": {...}, "data": {"<key>": {...}, ...}}` at depth 2.
 * Only object values are yielded (scalars at that depth are skipped).
 */
export async function* streamObjectEntries(chunks: AsyncIterable<string | Buffer>, targetDepth = 2): AsyncGenerator<[string, unknown]> {
  let depth = 0, inStr = false, esc = false;
  let key = '';
  let keyBuf: string | null = null; // collecting a string at the target depth
  let capturing = false, capStart = 0, capBuf = '';
  for await (const raw of chunks) {
    const s = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (capturing) capStart = 0;
    let keyStart = keyBuf !== null ? 0 : -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') {
          inStr = false;
          if (keyBuf !== null) {
            key = JSON.parse('"' + keyBuf + s.slice(keyStart, i) + '"');
            keyBuf = null;
            keyStart = -1;
          }
        }
        continue;
      }
      if (c === '"') {
        inStr = true;
        if (depth === targetDepth && !capturing) { keyBuf = ''; keyStart = i + 1; }
      } else if (c === '{' || c === '[') {
        if (depth === targetDepth && c === '{' && !capturing) { capturing = true; capStart = i; capBuf = ''; }
        depth++;
      } else if (c === '}' || c === ']') {
        depth--;
        if (capturing && depth === targetDepth) {
          capturing = false;
          yield [key, JSON.parse(capBuf + s.slice(capStart, i + 1))];
          capBuf = '';
        }
      }
    }
    if (capturing) capBuf += s.slice(capStart);
    if (keyBuf !== null) keyBuf += s.slice(keyStart);
  }
}
