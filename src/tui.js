import readline from 'node:readline';
import { width, truncate, pad, relTime, c } from './format.js';

const ESC = '\x1b';
const ALT_ON = ESC + '[?1049h';
const ALT_OFF = ESC + '[?1049l';
const CURSOR_HIDE = ESC + '[?25l';
const CURSOR_SHOW = ESC + '[?25h';
const CLEAR = ESC + '[2J' + ESC + '[H';

function homeShort(p) {
  const home = process.env.HOME;
  return home && p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '?';
}

/** Subsequence match — every query char appears in order. Cheap and forgiving. */
function fuzzy(haystack, needle) {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  let i = 0;
  for (const ch of n) {
    if (ch === ' ') continue;
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

function searchable(s) {
  return [s.label, s.cwd, s.gitBranch, s.id, ...(s.tags || []).map((t) => '#' + t)]
    .filter(Boolean)
    .join(' ');
}

function renderRow(s, cols, selected) {
  const timeCol = 9;
  const msgCol = 5;
  const tagText = (s.tags || []).length ? ' ' + (s.tags || []).map((t) => '#' + t).join(' ') : '';
  const cwdCol = Math.max(12, Math.min(30, Math.floor(cols * 0.28)));
  const tagCol = Math.min(width(tagText), Math.max(0, Math.floor(cols * 0.2)));
  const titleCol = Math.max(10, cols - timeCol - msgCol - cwdCol - tagCol - 6);

  const marker = selected ? '>' : ' ';
  const time = pad(relTime(s.updatedAt), timeCol);
  const msgs = pad(s.messages ? String(s.messages) : '-', msgCol);
  const title = pad(s.label, titleCol);
  const cwd = pad(homeShort(s.cwd), cwdCol);
  const tag = truncate(tagText, tagCol);

  const body = `${marker} ${time}${msgs}${title} ${cwd}${tag}`;
  if (selected) return c.inverse(pad(body, cols - 1));
  if (!s.resumable) return c.dim(body);
  return `${marker} ${c.dim(time)}${c.dim(msgs)}${title} ${c.blue(cwd)}${c.magenta(tag)}`;
}

/**
 * Interactive session picker. Returns the chosen session, or null if cancelled.
 * Falls back to null when stdout is not a TTY — the caller prints a plain list.
 */
export function pick(sessions, { title = 'Claude sessions', subtitle = '', query: initialQuery = '' } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let query = initialQuery;
    let cursor = 0;
    let offset = 0;
    let filtered = sessions;

    const out = process.stdout;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write(ALT_ON + CURSOR_HIDE);

    const cleanup = () => {
      out.write(CURSOR_SHOW + ALT_OFF);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      out.removeListener('resize', draw);
    };

    const applyFilter = () => {
      filtered = query ? sessions.filter((s) => fuzzy(searchable(s), query)) : sessions;
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    };

    function draw() {
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      const listHeight = Math.max(3, rows - 6);
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + listHeight) offset = cursor - listHeight + 1;

      const lines = [];
      lines.push(c.bold(title) + c.dim('  ' + subtitle));
      lines.push(c.cyan('search> ') + query + c.inverse(' '));
      lines.push(c.dim('─'.repeat(Math.min(cols - 1, 100))));

      const page = filtered.slice(offset, offset + listHeight);
      for (let i = 0; i < listHeight; i++) {
        const s = page[i];
        lines.push(s ? renderRow(s, cols, offset + i === cursor) : '');
      }
      lines.push(c.dim('─'.repeat(Math.min(cols - 1, 100))));
      lines.push(
        c.dim('↑↓/^n^p move · enter resume · ^u clear · esc quit') +
          (filtered.length ? c.dim(`   [${cursor + 1}/${filtered.length}]`) : c.red('   no match'))
      );
      out.write(CLEAR + lines.join('\n'));
    }

    function onKey(str, key) {
      if (!key) return;
      const done = (value) => {
        cleanup();
        resolve(value);
      };
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null);
      if (key.name === 'return' || key.name === 'enter') {
        const chosen = filtered[cursor];
        return chosen ? done(chosen) : undefined;
      }
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) cursor = Math.max(0, cursor - 1);
      else if (key.name === 'down' || (key.ctrl && key.name === 'n'))
        cursor = Math.min(filtered.length - 1, cursor + 1);
      else if (key.name === 'pageup') cursor = Math.max(0, cursor - 10);
      else if (key.name === 'pagedown') cursor = Math.min(filtered.length - 1, cursor + 10);
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = filtered.length - 1;
      else if (key.ctrl && key.name === 'u') {
        query = '';
        applyFilter();
      } else if (key.name === 'backspace') {
        query = query.slice(0, -1);
        applyFilter();
      } else if (str && !key.ctrl && !key.meta && str >= ' ') {
        query += str;
        cursor = 0;
        offset = 0;
        applyFilter();
      }
      draw();
    }

    applyFilter();
    process.stdin.on('keypress', onKey);
    out.on('resize', draw);
    draw();
  });
}
