// Hangul, CJK ideographs, and fullwidth forms occupy two terminal cells.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

const RESET = '\u001b[0m';

/**
 * Split a string into things that occupy a cell and things that do not.
 *
 * Colour is written inline as escape sequences, so measuring or cutting a
 * string naively counts those escapes as visible characters. A coloured line
 * then measures far wider than it looks and gets cut long before the edge of
 * the terminal, which is how the picker's key menu ended up truncated exactly
 * where it needed to be readable.
 */
function cells(str) {
  const out = [];
  const re = /\u001b\[[0-9;]*m|[\s\S]/gu;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[0]);
  return out;
}

const isEscape = (t) => t.charCodeAt(0) === 27;

/** Display width in terminal cells, ignoring colour escapes. */
export function width(str) {
  let w = 0;
  for (const t of cells(String(str))) {
    if (isEscape(t)) continue;
    w += WIDE.test(t) ? 2 : 1;
  }
  return w;
}

/** Truncate to `max` display cells, appending an ellipsis when cut. */
export function truncate(str, max) {
  const s = String(str);
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  let coloured = false;
  for (const t of cells(s)) {
    // Colour changes are kept whatever happens, so a cut cannot leave the text
    // painted in whatever the previous run set.
    if (isEscape(t)) {
      out += t;
      coloured = true;
      continue;
    }
    const cw = WIDE.test(t) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += t;
    w += cw;
  }
  return out + '\u2026' + (coloured ? RESET : '');
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
