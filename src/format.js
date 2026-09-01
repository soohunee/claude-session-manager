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

/** A byte count at a glance. Lives here rather than with the archive because it
 * is a formatter, and the picker needs it without reaching into storage. */
export function humanBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}

export const FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

/**
 * A one-line status that updates in place while something slow runs.
 *
 * Written to stderr so it never lands in a piped result, and reduced to a
 * single printed line when the output is not a terminal, since a carriage
 * return into a log file just produces noise.
 */
export function spinner(label) {
  const tty = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
  const started = Date.now();
  let text = label;
  let i = 0;
  const secs = () => Math.round((Date.now() - started) / 1000) + 's';
  if (!tty) {
    // No cursor to move, so each phase gets its own line. A carriage return
    // into a log file just produces noise, but silence would leave a piped run
    // looking hung for exactly as long as the interactive one does not.
    process.stderr.write(`  ${label}\n`);
    return {
      update: (next) => {
        if (next === text) return;
        text = next;
        process.stderr.write(`  ${next} (${secs()})\n`);
      },
      stop: () => {},
      elapsed: secs,
    };
  }
  const paint = () => {
    process.stderr.write(`\r\u001b[2K  ${FRAMES[i++ % FRAMES.length]} ${text} ${ESC}[2m${secs()}${ESC}[0m`);
  };
  paint();
  const timer = setInterval(paint, 80);
  return {
    update: (next) => {
      text = next;
      paint();
    },
    stop: () => {
      clearInterval(timer);
      process.stderr.write('\r\u001b[2K');
    },
    elapsed: secs,
  };
}

/** Ask a yes/no question on the terminal. Returns false when there is no terminal. */
export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
