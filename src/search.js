import fs from 'node:fs';
import { textOf } from './scan.js';
import { width } from './format.js';

/**
 * A needle is safe to look for in the raw JSONL only when JSON encoding cannot
 * have altered it. Quotes, backslashes and control characters are escaped on
 * the way in, so a literal scan would miss them.
 */
function scannableRaw(needle) {
  return !/["\\\n\r\t]/.test(needle);
}

/**
 * Find turns inside one transcript whose visible text contains `needle`.
 *
 * Matching the raw file first is what keeps a full-text search over dozens of
 * multi-megabyte transcripts cheap: files with no hit are never parsed, and in
 * files that do hit only the matching lines are.
 */
export function searchTranscript(file, needle, { limit = 3 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const n = needle.toLowerCase();
  if (scannableRaw(needle) && !raw.toLowerCase().includes(n)) return [];

  const hits = [];
  for (const line of raw.split('\n')) {
    if (line.length < 2) continue;
    if (scannableRaw(needle) && !line.toLowerCase().includes(n)) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain || d.isMeta) continue;
    const role = d.type === 'user' ? 'user' : d.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const body = textOf(d.message).replace(/\s+/g, ' ').trim();
    if (!body || body.startsWith('<')) continue;
    // The raw line can match on metadata the reader never sees, so the hit only
    // counts once it is found in the visible text.
    const at = body.toLowerCase().indexOf(n);
    if (at === -1) continue;
    hits.push({ role, text: body, at, length: needle.length });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * A window of at most `budget` terminal cells centred on the match.
 *
 * Measured in cells rather than characters: a snippet of Korean or Japanese
 * holds half as many characters as one of English, and counting characters
 * would wrap the line.
 */
export function snippet(hit, budget = 92) {
  const chars = [...hit.text];
  // hit.at is an index into the string; convert it to a character index.
  const start = [...hit.text.slice(0, hit.at)].length;
  const end = start + [...hit.text.slice(hit.at, hit.at + hit.length)].length;
  const matchWidth = width(hit.text.slice(hit.at, hit.at + hit.length));

  let left = start;
  let right = end;
  let used = Math.min(matchWidth, budget);
  // Grow outward one character at a time, preferring the left so the match
  // does not sit flush against the start of the line.
  while (used < budget && (left > 0 || right < chars.length)) {
    if (left > 0) {
      const w = width(chars[left - 1]);
      if (used + w > budget) break;
      left--;
      used += w;
    }
    if (right < chars.length && used < budget) {
      const w = width(chars[right]);
      if (used + w > budget) break;
      right++;
      used += w;
    }
    if (left === 0 && right === chars.length) break;
  }

  const head = left > 0 ? '…' : '';
  const tail = right < chars.length ? '…' : '';
  const text = head + chars.slice(left, right).join('') + tail;
  return {
    text,
    at: head.length + chars.slice(left, start).join('').length,
    length: chars.slice(start, end).join('').length,
  };
}
