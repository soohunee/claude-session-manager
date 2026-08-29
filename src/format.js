// Hangul, CJK ideographs, and fullwidth forms occupy two terminal cells.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

/** Display width in terminal cells. */
export function width(str) {
  let w = 0;
  for (const ch of String(str)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** Truncate to `max` display cells, appending an ellipsis when cut. */
export function truncate(str, max) {
  const s = String(str);
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Truncate, then pad to exactly `max` display cells. */
export function pad(str, max) {
  const s = truncate(str, max);
  return s + ' '.repeat(Math.max(0, max - width(s)));
}

export function relTime(ts) {
  if (!ts) return '?';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '?';
  const mins = Math.max(0, (Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return Math.floor(mins) + 'm ago';
  const hours = mins / 60;
  if (hours < 24) return Math.floor(hours) + 'h ago';
  const days = hours / 24;
  if (days < 7) return Math.floor(days) + 'd ago';
  if (days < 365) return Math.floor(days / 7) + 'w ago';
  return Math.floor(days / 365) + 'y ago';
}

const ESC = String.fromCharCode(27);
const on = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (on ? ESC + '[' + code + 'm' + s + ESC + '[0m' : String(s));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  inverse: wrap(7),
};

export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}
