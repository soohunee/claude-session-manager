import readline from 'node:readline';
import { width, truncate, pad, relTime, c } from './format.js';
import { tailMessages } from './preview.js';
import { sortSessions, SORT_MODES } from './scan.js';

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

/**
 * Everything the picker can do, in the order the menu lists it.
 *
 * The menu is the whole point of the rework: a user should be able to open csm
 * and read what is available rather than having to already know. So this list
 * is the single source of truth for both the on-screen menu and the help
 * overlay, and a key that is not in it does nothing.
 */
export const ACTIONS = [
  { key: 'enter', label: 'Resume', needs: 'resumable' },
  { key: 'f', label: 'Fork', needs: 'resumable' },
  { key: 'r', label: 'Remote', needs: 'resumable' },
  { key: 'y', label: 'Print cmd', needs: 'resumable' },
  { key: '/', label: 'Filter' },
  { key: 's', label: 'Sort' },
  { key: 't', label: 'Tagged only' },
  { key: 'p', label: 'Preview' },
  { key: '?', label: 'Help' },
  { key: 'esc', label: 'Quit' },
];

/**
 * Mark each action enabled or not for the session under the cursor.
 *
 * This is the part that actually teaches. A menu that lists everything the tool
 * can ever do is a manual; a menu that answers "what can I do with *this* row"
 * is something you read instead of learning. An unavailable action stays listed
 * and goes dim, so the answer to "why can't I resume this one" is on screen
 * rather than in the docs.
 */
export function menuFor(session) {
  return ACTIONS.map((a) => {
    if (!a.needs) return a;
    const enabled = a.needs === 'resumable' ? Boolean(session && session.resumable) : true;
    return { ...a, enabled };
  });
}

/**
 * Lay the key menu out in columns.
 *
 * Columns are dropped before characters ever are. A truncated menu would hide
 * an action from the one person who needs to be told it exists, so a narrow
 * terminal gets fewer columns and more rows instead of shorter labels.
 */
export function layoutMenu(entries, avail, gap = 3) {
  if (!entries.length || avail < 8) return [];
  const keyCol = Math.max(...entries.map((e) => width(e.key)));
  const labelCol = Math.max(...entries.map((e) => width(e.label)));
  const colWidth = keyCol + 2 + labelCol + gap;
  const columns = Math.max(1, Math.min(entries.length, Math.floor((avail + gap) / colWidth)));
  const rows = Math.ceil(entries.length / columns);

  const lines = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let col = 0; col < columns; col++) {
      // Column-major, so reading down a column follows the declared order.
      const e = entries[col * rows + r];
      if (!e) continue;
      const key = pad(e.key, keyCol);
      const label = pad(e.label, labelCol);
      // A disabled cell is dimmed as one piece. Wrapping a bold key inside a
      // dim cell does not work: the reset that closes the bold closes the dim
      // with it, and the label comes out at full brightness.
      cells.push(e.enabled === false ? c.dim(key + '  ' + label) : c.bold(key) + '  ' + label);
    }
    lines.push(cells.join(' '.repeat(gap)));
  }
  return lines;
}

/**
 * One line of as many keys as fit, for a terminal too small for the grid.
 *
 * It always ends by naming the way to see the rest, so the fallback still says
 * "there is more here" rather than quietly shrinking the tool.
 */
export function compactMenu(entries, avail) {
  const more = '?  More keys';
  const sep = ' \u00b7 ';
  let out = '';
  let used = width(more);
  for (const e of entries) {
    if (e.key === '?' || e.enabled === false) continue;
    const cost = width(`${e.key} ${e.label}`) + width(sep);
    if (used + cost > avail) break;
    out += (out ? sep : '') + c.bold(e.key) + ' ' + e.label;
    used += cost;
  }
  return out ? out + c.dim(sep + more) : c.dim(more);
}

function tagsOf(s) {
  return (s.tags || []).length ? ' ' + s.tags.map((t) => '#' + t).join(' ') : '';
}

/**
 * How wide the tag column has to be for a whole page.
 *
 * Sizing it per row made the title column a different width on every line, so
 * the directory and tag columns stepped in and out and the list stopped reading
 * as a table. One width for the page keeps them in line.
 */
function tagWidth(page, cols) {
  const widest = page.reduce((n, s) => Math.max(n, width(tagsOf(s))), 0);
  return Math.min(widest, Math.max(0, Math.floor(cols * 0.2)));
}

function renderRow(s, cols, selected, tagCol) {
  const timeCol = 9;
  const msgCol = 5;
  const tagText = tagsOf(s);
  const cwdCol = Math.max(12, Math.min(30, Math.floor(cols * 0.28)));
  const titleCol = Math.max(10, cols - timeCol - msgCol - cwdCol - tagCol - 6);

  const marker = selected ? '>' : ' ';
  const time = pad(relTime(s.updatedAt), timeCol);
  const msgs = pad(s.messages ? String(s.messages) : '-', msgCol);
  const title = pad(s.label, titleCol);
  const cwd = pad(homeShort(s.cwd), cwdCol);
  const tag = pad(tagText, tagCol);

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

function helpOverlay(cols, rows) {
  const lines = [c.bold('Keys'), ''];
  for (const a of ACTIONS) lines.push(`  ${c.bold(pad(a.key, 7))} ${a.label}`);
  lines.push('');
  lines.push(c.dim('  A key shown dim does not apply to the highlighted session.'));
  lines.push(c.dim('  Expired sessions have no transcript left, so they cannot be resumed.'));
  lines.push('');
  lines.push(c.bold('Moving'));
  lines.push(`  ${c.bold(pad('j k', 7))} Down / up (arrows work too)`);
  lines.push(`  ${c.bold(pad('g G', 7))} First / last`);
  lines.push(`  ${c.bold(pad('ctrl-d', 7))} Half a page down (ctrl-u for up)`);
  lines.push('');
  lines.push(c.bold('While filtering'));
  lines.push(`  ${c.bold(pad('enter', 7))} Back to the list, keeping the filter`);
  lines.push(`  ${c.bold(pad('esc', 7))} Back to the list, clearing it`);
  lines.push('');
  lines.push(c.dim('Any key closes this.'));
  return lines.slice(0, rows).map((l) => truncate(l, cols - 1));
}

/**
 * Interactive session picker. Resolves `{ session, action }`, or null if
 * cancelled. Falls back to null when stdout is not a TTY — the caller prints a
 * plain list instead.
 *
 * Keys are bare letters and the menu describing them is always on screen. That
 * is the whole design: the previous picker hid ten Ctrl chords behind a hint
 * line that truncated on a narrow terminal, so the features a new user most
 * needed pointing out were the first to disappear.
 */
export function pick(sessions, { scope = '', subtitle = '', query: initialQuery = '', preview: previewOn = false, sort: sortMode = 'time', tagged: taggedOnly = false, version = '' } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let query = initialQuery;
    let cursor = 0;
    let offset = 0;
    let showPreview = previewOn;
    let onlyTagged = taggedOnly;
    let sort = sortMode;
    let mode = 'normal';
    let overlay = null;
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
      const pool = onlyTagged ? ordered.filter((s) => (s.tags || []).length > 0) : ordered;
      filtered = query ? pool.filter((s) => fuzzy(searchable(s), query)) : pool;
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    };

    /** Change the view without losing the session the cursor was on. */
    const keepingCursor = (fn) => {
      const keep = filtered[cursor];
      fn();
      applyFilter();
      const at = keep ? filtered.indexOf(keep) : -1;
      cursor = at === -1 ? 0 : at;
      offset = 0;
    };

    function header(cols) {
      const left = [
        c.bold('csm') + (version ? c.dim(' ' + version) : '') + (scope ? '  ' + c.magenta(scope) : ''),
        c.dim(subtitle || `${filtered.length} shown`),
        c.dim(`sort ${sort}`) + (onlyTagged ? ' ' + c.magenta('tagged only') : ''),
        mode === 'filter'
          ? c.cyan('/') + query + c.inverse(' ')
          : query
            ? c.dim('filter ') + query
            : c.dim('press / to filter'),
      ];
      const leftWidth = Math.max(...left.map(width)) + 3;
      const entries = menuFor(filtered[cursor]);
      const menu = layoutMenu(entries, cols - leftWidth - 2);
      // The grid may not fit beside the state block on a narrow or short
      // terminal. It is allowed a couple of rows more than the block before the
      // single-line fallback takes over, because losing the grid costs more
      // than two rows of list does.
      const budget = Math.max(left.length, Math.min(6, Math.floor((out.rows || 24) * 0.3)));
      const grid = menu.length > 0 && menu.length <= budget;
      const rows = grid ? Math.max(left.length, menu.length) : left.length;
      const lines = [];
      for (let i = 0; i < rows; i++) {
        const l = left[i] ?? '';
        const m = grid ? menu[i] ?? '' : '';
        lines.push(' ' + l + (m ? ' '.repeat(Math.max(1, leftWidth - width(l))) + m : ''));
      }
      if (!grid) lines.push(' ' + compactMenu(entries, cols - 3));
      return lines;
    }

    function draw() {
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      if (overlay === 'help') {
        out.write(CLEAR + helpOverlay(cols, rows).join('\n'));
        return;
      }

      const head = header(cols);
      const previewHeight = showPreview ? Math.min(11, Math.max(5, Math.floor(rows * 0.4))) : 0;
      const chrome = head.length + 3 + (showPreview ? previewHeight + 1 : 0);
      const listHeight = Math.max(3, rows - chrome);
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + listHeight) offset = cursor - listHeight + 1;

      const rule = c.dim('─'.repeat(Math.min(cols - 1, 100)));
      const lines = [...head, rule];

      const page = filtered.slice(offset, offset + listHeight);
      const tagCol = tagWidth(page, cols);
      for (let i = 0; i < listHeight; i++) {
        const s = page[i];
        lines.push(s ? renderRow(s, cols, offset + i === cursor, tagCol) : '');
      }
      lines.push(rule);

      if (showPreview) {
        const panel = renderPreview(filtered[cursor], cols, previewHeight, previewCache);
        for (let i = 0; i < previewHeight; i++) lines.push(panel[i] ?? '');
        lines.push(rule);
      }

      lines.push(
        (mode === 'filter' ? c.cyan(' FILTER ') + c.dim('enter keeps it, esc clears it') : c.dim(' NORMAL')) +
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
        // The menu already dims these, so refusing here is just keeping the two
        // in agreement rather than a second, hidden rule.
        if (!chosen || !chosen.resumable) return draw();
        return done({ session: chosen, action });
      };

      if (key.ctrl && key.name === 'c') return done(null);
      if (overlay) {
        overlay = null;
        return draw();
      }

      if (mode === 'filter') {
        if (key.name === 'escape') {
          query = '';
          mode = 'normal';
          applyFilter();
        } else if (key.name === 'return' || key.name === 'enter') {
          mode = 'normal';
        } else if (key.ctrl && key.name === 'u') {
          query = '';
          applyFilter();
        } else if (key.name === 'backspace') {
          query = query.slice(0, -1);
          cursor = 0;
          offset = 0;
          applyFilter();
        } else if (str && !key.ctrl && !key.meta && str >= ' ') {
          query += str;
          cursor = 0;
          offset = 0;
          applyFilter();
        }
        return draw();
      }

      // NORMAL: bare letters are commands, which is why filtering moved behind
      // `/`. Nothing falls through to the query here on purpose — a key that
      // sometimes searched and sometimes acted would be worse than either.
      const last = Math.max(0, filtered.length - 1);
      const page = Math.max(1, Math.floor(((out.rows || 24) - 8) / 2));
      if (key.name === 'escape' || key.name === 'q') return done(null);
      if (key.name === 'return' || key.name === 'enter') return act('resume');
      if (key.name === 'f') return act('fork');
      if (key.name === 'r') return act('remote');
      if (key.name === 'y') return act('print');

      if (str === '/') mode = 'filter';
      else if (str === '?') overlay = 'help';
      else if (key.name === 'p' && !key.ctrl) showPreview = !showPreview;
      else if (key.name === 't') keepingCursor(() => (onlyTagged = !onlyTagged));
      else if (key.name === 's') {
        keepingCursor(() => {
          sort = SORT_MODES[(SORT_MODES.indexOf(sort) + 1) % SORT_MODES.length];
          ordered = sortSessions(sessions, sort);
        });
      } else if (key.name === 'j' || key.name === 'down') cursor = Math.min(last, cursor + 1);
      else if (key.name === 'k' || key.name === 'up') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'g' && !key.shift) cursor = 0;
      else if (key.name === 'g' && key.shift) cursor = last;
      else if (key.ctrl && key.name === 'd') cursor = Math.min(last, cursor + page);
      else if (key.ctrl && key.name === 'u') cursor = Math.max(0, cursor - page);
      else if (key.name === 'pagedown') cursor = Math.min(last, cursor + page);
      else if (key.name === 'pageup') cursor = Math.max(0, cursor - page);
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = last;
      draw();
    }

    applyFilter();
    if (query) mode = 'normal';
    process.stdin.on('keypress', onKey);
    out.on('resize', draw);
    draw();
  });
}
