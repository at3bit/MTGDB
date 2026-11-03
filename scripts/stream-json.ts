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

