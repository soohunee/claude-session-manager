import readline from 'node:readline';
import { width, truncate, pad, relTime, c } from './format.js';
import { tailMessages } from './preview.js';
import { sortSessions } from './scan.js';

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

function absTime(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '?';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The detail panel under the list: metadata the columns cannot fit, plus the
 * tail of the conversation, which is usually what actually identifies a session
 * when several share a title.
 */
function renderPreview(s, cols, height, cache) {
  const lines = [];
  const w = cols - 2;
  if (!s) return lines;

  const meta = [
    `${absTime(s.updatedAt)} · ${s.messages || 0} messages`,
    s.gitBranch ? `· ${s.gitBranch}` : '',
    s.archived ? '· archived' : '',
  ]
    .filter(Boolean)
    .join(' ');

  lines.push(c.bold(truncate(s.label, w)));
  lines.push(c.dim(truncate(meta, w)));
  lines.push(c.blue(truncate(homeShort(s.cwd), w)));
  lines.push(
    c.dim(truncate(s.id, w)) + ((s.tags || []).length ? ' ' + c.magenta(s.tags.map((t) => '#' + t).join(' ')) : '')
  );
  lines.push('');

  const room = Math.max(0, height - lines.length);
  if (room === 0) return lines.slice(0, height);

  if (!s.resumable) {
    lines.push(c.red('Transcript deleted by Claude Code cleanup — nothing left to show.'));
  } else {
    if (!cache.has(s.id)) cache.set(s.id, s.file ? tailMessages(s.file, { limit: room }) : []);
    const msgs = cache.get(s.id).slice(-room);
    if (!msgs.length) lines.push(c.dim('(no readable messages)'));
    for (const m of msgs) {
      const mark = m.role === 'user' ? c.cyan('›') : c.dim('‹');
      lines.push(`${mark} ${truncate(m.text, w - 2)}`);
    }
  }
  return lines.slice(0, height);
}

/**
 * Interactive session picker. Resolves `{ session, action }`, or null if
 * cancelled. Falls back to null when stdout is not a TTY — the caller prints a
 * plain list instead.
 */
export function pick(sessions, { title = 'Claude sessions', subtitle = '', query: initialQuery = '', preview: previewOn = false, sort: sortMode = 'time' } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let query = initialQuery;
    let cursor = 0;
    let offset = 0;
    let showPreview = previewOn;
    let sort = sortMode;
    let ordered = sortSessions(sessions, sort);
    let filtered = ordered;
    const previewCache = new Map();

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
      filtered = query ? ordered.filter((s) => fuzzy(searchable(s), query)) : ordered;
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    };

    const reorder = (mode) => {
      const keep = filtered[cursor];
      sort = mode;
      ordered = sortSessions(sessions, sort);
      applyFilter();
      const at = keep ? filtered.indexOf(keep) : -1;
      cursor = at === -1 ? 0 : at;
      offset = 0;
    };

    function draw() {
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      const previewHeight = showPreview ? Math.min(11, Math.max(5, Math.floor(rows * 0.4))) : 0;
      const chrome = 6 + (showPreview ? previewHeight + 1 : 0);
      const listHeight = Math.max(3, rows - chrome);
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + listHeight) offset = cursor - listHeight + 1;

      const rule = c.dim('─'.repeat(Math.min(cols - 1, 100)));
      const lines = [];
      lines.push(c.bold(title) + c.dim('  ' + subtitle));
      lines.push(c.cyan('search> ') + query + c.inverse(' '));
      lines.push(rule);

      const page = filtered.slice(offset, offset + listHeight);
      for (let i = 0; i < listHeight; i++) {
        const s = page[i];
        lines.push(s ? renderRow(s, cols, offset + i === cursor) : '');
      }
      lines.push(rule);

      if (showPreview) {
        const panel = renderPreview(filtered[cursor], cols, previewHeight, previewCache);
        for (let i = 0; i < previewHeight; i++) lines.push(panel[i] ?? '');
        lines.push(rule);
      }

      const help = showPreview
        ? '↑↓ move · enter resume · tab hide · ^r remote · ^f fork · ^y cmd · esc quit'
        : '↑↓ move · enter resume · tab preview · ^r remote · ^f fork · ^y cmd · esc quit';
      lines.push(
        c.dim(truncate(help, Math.max(20, cols - 24))) +
          c.dim(` sort:${sort}`) +
          (filtered.length ? c.dim(`  [${cursor + 1}/${filtered.length}]`) : c.red('  no match'))
      );
      out.write(CLEAR + lines.join('\n'));
    }

    function onKey(str, key) {
      if (!key) return;
      const done = (value) => {
        cleanup();
        resolve(value);
      };
      const act = (action) => {
        const chosen = filtered[cursor];
        return chosen ? done({ session: chosen, action }) : undefined;
      };

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null);
      if (key.name === 'return' || key.name === 'enter') return act('resume');
      if (key.ctrl && key.name === 'r') return act('remote');
      if (key.ctrl && key.name === 'f') return act('fork');
      if (key.ctrl && key.name === 'y') return act('print');

      if (key.name === 'tab') showPreview = !showPreview;
      else if (key.ctrl && key.name === 't') reorder('time');
      else if (key.ctrl && key.name === 'o') reorder('title');
      else if (key.ctrl && key.name === 'g') reorder('dir');
      else if (key.name === 'up' || (key.ctrl && key.name === 'p')) cursor = Math.max(0, cursor - 1);
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
