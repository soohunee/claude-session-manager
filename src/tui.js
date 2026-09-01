import readline from 'node:readline';
import { width, truncate, pad, relTime, humanBytes, humanTokens, FRAMES, c } from './format.js';
import { tailMessages } from './preview.js';
import { sortSessions, isUnnamed, SORT_MODES } from './scan.js';
import { buildTree } from './links.js';

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

/**
 * Fit a path into a column by dropping leading segments, not trailing ones.
 *
 * `truncate` would give `~/Desktop/develop/claude-sess…`, which throws away the
 * only part that says which project this is. Every session in a tree of work
 * shares its leading segments; the tail is what tells them apart.
 */
export function shortPath(p, max) {
  const full = homeShort(p);
  if (width(full) <= max) return full;
  const parts = full.split('/');
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + out;
    if (width('…/' + next) > max) break;
    out = next;
  }
  const marked = '…/' + out;
  // A single segment can still be too long for the column on its own.
  return width(marked) <= max ? marked : truncate(full, max);
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
  { key: 'enter', label: 'Resume', needs: 'resumable', help: 'Carry on in this session; what you say next is added to it' },
  { key: 'f', label: 'Resume a copy', needs: 'resumable', help: 'Branch: continue under a new id, leaving this one exactly as it is' },
  { key: 'r', label: 'Remote control', needs: 'resumable', help: 'Resume with Remote Control, to carry on from your phone' },
  { key: 'y', label: 'Print cmd', needs: 'resumable', help: 'Print the command that would resume it, and quit' },
  { key: 'n', label: 'New from this', needs: 'resumable', help: 'Hand this session to a fresh one, for when it has filled up' },
  { key: 'd', label: 'Untag', needs: 'tagged', help: 'Remove its tags; the archived copy goes with the last one' },
  { key: 'a', label: 'Archive', needs: 'archivable', help: 'Keep a copy that outlives Claude Code deleting the transcript' },
  { key: '/', label: 'Filter', help: 'Type to narrow the list; enter keeps the filter, esc clears it' },
  { key: 's', label: 'Sort', help: 'Cycle the order: time, title, directory' },
  { key: 't', label: 'Tag filter', help: 'Cycle: everything, anything tagged, then one tag at a time' },
  { key: '.', label: 'Show expired', help: 'Include sessions Claude Code has already deleted the transcript of' },
  { key: ',', label: 'Show unnamed', help: 'Include what running a slash command left behind, which Claude Code never named' },
  { key: 'c', label: 'This dir only', needs: 'cwd', help: "Narrow to the selected session's directory, and back again" },
  { key: 'g', label: 'Tree', help: 'Nest sessions under the ones they were derived from' },
  { key: 'u', label: 'Go to parent', needs: 'parent', help: 'Move to the session this one was derived from' },
  { key: 'p', label: 'Preview', help: 'Show the tail of the conversation under the list' },
  { key: '?', label: 'Help', help: 'This screen' },
  { key: 'esc', label: 'Quit', help: 'Leave csm; q works too' },
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
    const enabled =
      a.needs === 'resumable'
        ? Boolean(session && session.resumable)
        : a.needs === 'tagged'
          ? Boolean(session && (session.tags || []).length)
          : a.needs === 'archivable'
            ? Boolean(session && session.resumable && session.file && !session.archived)
            : a.needs === 'cwd'
              ? Boolean(session && session.cwd)
              : a.needs === 'parent'
                ? Boolean(session && session.parent)
                : true;
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
  // Not even one column fits. Returning nothing hands the caller over to the
  // compact line, which drops whole entries; forcing a column here would have
  // overflowed the width instead, which is the one thing the layout must not do.
  if (colWidth - gap > avail) return [];
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

/**
 * One set of column widths for the header and every row.
 *
 * They were computed inside the row renderer, which was fine while nothing else
 * needed them; a header that works out its own widths is a header that drifts
 * out of line with the thing it labels.
 */
function columns(cols, tagCol) {
  const time = 9;
  const msgs = 5;
  const ctx = 6;
  const cwd = Math.max(12, Math.min(30, Math.floor(cols * 0.28)));
  return { time, msgs, ctx, cwd, title: Math.max(10, cols - time - msgs - ctx - cwd - tagCol - 6) };
}

/**
 * How much context the session was holding when it was last answered.
 *
 * Shown as a count rather than a percentage on purpose: the size of the window
 * is not in the transcript, is not in settings.json, and moves with the model
 * and with `claude --autocompact`. A percentage would need a denominator csm
 * would be inventing. Pass one with `--context-window` and it will use it.
 */
function contextCell(s, window) {
  if (!s.contextTokens) return c.dim(pad('-', 6));
  if (!window) return c.dim(pad(humanTokens(s.contextTokens), 6));
  const pct = Math.round((s.contextTokens / window) * 100);
  const text = pad(pct + '%', 6);
  if (pct >= 90) return c.red(text);
  if (pct >= 70) return c.yellow(text);
  return c.dim(text);
}

/** The column labels. `msgs` is the one nobody can guess from the numbers. */
function renderHeader(cols, tagCol, window) {
  const w = columns(cols, tagCol);
  const line = `  ${pad('when', w.time)}${pad('msgs', w.msgs)}${pad(window ? 'ctx%' : 'ctx', w.ctx)}${pad('title', w.title)} ${pad('directory', w.cwd)}${pad(tagCol ? ' tags' : '', tagCol)}`;
  return c.dim(line);
}

function renderRow(s, cols, selected, tagCol, repeated = false, window = null) {
  const { time: timeCol, msgs: msgCol, ctx: ctxCol, cwd: cwdCol, title: titleCol } = columns(cols, tagCol);
  const tagText = tagsOf(s);

  const marker = selected ? '>' : ' ';
  const time = pad(relTime(s.updatedAt), timeCol);
  const msgs = pad(s.messages ? String(s.messages) : '-', msgCol);
  const title = pad((s.depth ? '  '.repeat(s.depth - 1) + '\u2514 ' : '') + s.label, titleCol);
  // Repeating the directory down every row spends the widest column on the one
  // thing those rows have in common. Printed once per run of rows that share
  // it, the column starts carrying information again.
  const cwd = pad(repeated ? '' : shortPath(s.cwd, cwdCol), cwdCol);
  const tag = pad(tagText, tagCol);

  const ctxText = s.contextTokens ? (window ? Math.round((s.contextTokens / window) * 100) + '%' : humanTokens(s.contextTokens)) : '-';
  const body = `${marker} ${time}${msgs}${pad(ctxText, ctxCol)}${title} ${cwd}${tag}`;
  if (selected) return c.inverse(pad(body, cols - 1));
  if (!s.resumable) return c.dim(body);
  return `${marker} ${c.dim(time)}${c.dim(msgs)}${contextCell(s, window)}${title} ${c.blue(cwd)}${c.magenta(tag)}`;
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
    s.contextTokens ? `· ${s.contextTokens.toLocaleString()} tokens of context` : '',
    s.model ? `· ${s.model}` : '',
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

/** Break a paragraph onto lines that fit, without cutting a word in half. */
function wrapText(text, max) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? line + ' ' + word : word;
    if (width(next) > max && line) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Centre one line inside a given width. */
function centre(text, inner) {
  const left = Math.max(0, Math.floor((inner - width(text)) / 2));
  return ' '.repeat(left) + text;
}

/**
 * Draw a dialog over the middle of the screen, leaving the list visible around
 * it.
 *
 * The list stays behind the box on purpose: a question about a session is worth
 * asking with the session still in view. Choices are buttons picked with the
 * arrows and enter rather than a line of key hints, because a dialog that
 * recites its own shortcuts is asking the reader to do the work of a menu.
 */
function drawDialog(lines, cols, { title, body = [], buttons = [], at = 0 }) {
  const row = buttons.map((b, i) => (i === at ? c.inverse(` ${b.label} `) : c.dim(` ${b.label} `))).join('  ');
  const content = ['', ...body, ...(buttons.length ? ['', row] : []), ''];
  const label = `\u2500 <${title}> `;

  // `inner` is the full outer width, borders included, so every line is built
  // to the same number and the frame cannot come out ragged.
  const room = Math.max(28, Math.min(64, cols - 8));
  const inner = Math.min(Math.max(width(label) + 3, ...content.map((l) => width(l) + 6)), room);
  const cell = inner - 6;

  const pane = [
    c.yellow('\u256d' + label + '\u2500'.repeat(Math.max(0, inner - 2 - width(label))) + '\u256e'),
    ...content.map((l) => {
      const text = l === row && buttons.length ? centre(l, cell) : l;
      return c.yellow('\u2502') + '  ' + pad(text, cell) + '  ' + c.yellow('\u2502');
    }),
    c.yellow('\u2570' + '\u2500'.repeat(Math.max(0, inner - 2)) + '\u256f'),
  ];

  const left = Math.max(0, Math.floor((cols - inner) / 2));
  const top = Math.max(0, Math.floor((lines.length - pane.length) / 2));
  for (let i = 0; i < pane.length && top + i < lines.length; i++) {
    lines[top + i] = ' '.repeat(left) + pane[i];
  }
  return lines;
}

function helpOverlay(cols, rows) {
  const keyCol = Math.max(...ACTIONS.map((a) => width(a.key)));
  const labelCol = Math.max(...ACTIONS.map((a) => width(a.label)));
  const lines = [c.bold(' Keys'), ''];
  for (const a of ACTIONS) {
    lines.push(
      '  ' + c.bold(pad(a.key, keyCol)) + '  ' + pad(a.label, labelCol) + '  ' + c.dim(truncate(a.help, Math.max(10, cols - keyCol - labelCol - 8)))
    );
  }
  lines.push('');
  lines.push(c.dim('  A key shown dim in the menu does not apply to the highlighted session.'));
  lines.push(c.dim('  Move with j k or the arrows, ctrl-d and ctrl-u by half a page, G to the end.'));
  lines.push(c.dim('  In a dialog: left and right pick a button, enter runs it, esc backs out.'));
  lines.push(c.dim('  The safe button is always the one already selected.'));
  lines.push('');
  lines.push(c.dim('  Any key closes this.'));
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
export function pick(sessions, { actions = {}, scope = '', subtitle = '', expired = false, unnamed = false, dir = null, tag: taggedOnly = null, tree = false, contextWindow = null, query: initialQuery = '', preview: previewOn = false, sort: sortMode = 'time', version = '' } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let query = initialQuery;
    let cursor = 0;
    let offset = 0;
    let showPreview = previewOn;
    // `t` cycles rather than toggles, so narrowing to one tag does not need a
    // flag: off, then any tag, then each tag in turn.
    const tagCycle = [null, '*', ...[...new Set(sessions.flatMap((x) => x.tags || []))].sort()];
    let tagAt = Math.max(0, tagCycle.indexOf(taggedOnly));
    let showExpired = expired;
    let showTree = tree;
    let showUnnamed = unnamed;
    // Narrowing to a directory is a toggle rather than a flag, so it has to
    // remember which directory it was narrowed to.
    let onlyDir = dir;
    let sort = sortMode;
    let mode = 'normal';
    let overlay = null;
    let flash = '';
    // The pool is reloaded in place after an action, so it cannot stay the
    // caller's array.
    let pool = sessions;
    let ordered = sortSessions(pool, sort);
    let filtered = ordered;
    const previewCache = new Map();

    const out = process.stdout;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write(ALT_ON + CURSOR_HIDE);

    // Hoisted above the key handler because the derive boxes resolve the picker
    // from a callback, long after the keypress that opened them has returned.
    const done = (value) => {
      cleanup();
      resolve(value);
    };

    const cleanup = () => {
      out.write(CURSOR_SHOW + ALT_OFF);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      out.removeListener('resize', draw);
    };

    const applyFilter = () => {
      let list = ordered;
      if (!showExpired) list = list.filter((s) => s.resumable);
      if (!showUnnamed) list = list.filter((s) => !isUnnamed(s));
      const tag = tagCycle[tagAt];
      if (tag === '*') list = list.filter((s) => (s.tags || []).length > 0);
      else if (tag) list = list.filter((s) => (s.tags || []).includes(tag));
      if (onlyDir) list = list.filter((s) => s.cwd === onlyDir);
      list = query ? list.filter((s) => fuzzy(searchable(s), query)) : list;
      // Nesting comes last so it only ever arranges what survived the filters,
      // and a child whose parent was filtered out is promoted rather than lost.
      filtered = showTree ? buildTree(list) : list;
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    };

    // A filter that silently drops rows is indistinguishable from a bug, so the
    // header says how many are being held back and the key that shows them is
    // in the menu.
    const hiddenUnnamed = () => (showUnnamed ? 0 : ordered.filter((s) => isUnnamed(s) && (showExpired || s.resumable)).length);

    /**
     * Everything that happens before csm hands the terminal over.
     *
     * Deriving ends in an interactive Claude Code session, which has to own the
     * screen, exactly as k9s gives its screen up to shell into a pod. What does
     * not have to leave is the question about spending money and the wait that
     * follows it, and dropping out to a bare terminal for those was the jarring
     * part: the picker vanished, then asked, then sat silent.
     */
    const askDerive = (session) => {
      const size = session.sizeBytes ? ` \u00b7 ${humanBytes(session.sizeBytes)}` : '';
      overlay = {
        kind: 'dialog',
        title: 'New session from this',
        body: [
          c.bold(truncate(session.label, 52)),
          c.dim(`${session.messages || 0} messages${size}`),
          '',
          'The model re-reads all of it: one billed API call.',
          'From the transcript is instant and free.',
        ],
        buttons: [
          { label: 'Cancel' },
          { label: 'From transcript', run: () => runDerive(session, true) },
          { label: 'Use the model', run: () => runDerive(session, false) },
        ],
        at: 0,
      };
      draw();
    };

    const runDerive = (session, fast) => {
      if (fast || !actions.summarize) return done({ session, action: 'derive', handoff: null });
      const started = Date.now();
      const phases = {
        loading: 'reading the conversation',
        waiting: 'the model is reading it',
        writing: 'writing the handoff',
      };
      let phase = phases.loading;
      let tick = 0;
      const paint = () => {
        const secs = Math.round((Date.now() - started) / 1000);
        overlay = {
          kind: 'busy',
          title: 'Writing the handoff',
          body: [
            c.bold(truncate(session.label, 52)),
            '',
            `${c.cyan(FRAMES[tick++ % FRAMES.length])} ${phase}` + c.dim(`   ${secs}s`),
          ],
          buttons: [],
        };
        draw();
      };
      paint();
      const ticker = setInterval(paint, 120);
      actions
        .summarize(session, (next) => {
          phase = phases[next] || next;
          paint();
        })
        .then((res) => {
          clearInterval(ticker);
          overlay = null;
          // A failed summary still derives, from the transcript. Stopping here
          // would throw away a decision the user already made.
          done({ session, action: 'derive', handoff: res.ok ? res : null, warning: res.ok ? null : res.reason });
        });
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
        c.dim(`${filtered.length} shown`) +
          (hiddenUnnamed() ? c.dim(` · ${hiddenUnnamed()} unnamed hidden`) : '') +
          (subtitle ? c.dim(' · ' + subtitle) : ''),
        c.dim(`sort ${sort}`) +
          (tagCycle[tagAt] === '*' ? ' ' + c.magenta('tagged') : tagCycle[tagAt] ? ' ' + c.magenta('#' + tagCycle[tagAt]) : '') +
          (showExpired ? ' ' + c.magenta('expired') : '') +
          (onlyDir ? ' ' + c.magenta(homeShort(onlyDir)) : '') +
          (showTree ? ' ' + c.magenta('tree') : ''),
        mode === 'filter'
          ? c.cyan('/') + query + c.inverse(' ')
          : query
            ? c.dim('filter ') + query
            : c.dim('press / to filter'),
      ];
      // The state block is capped so it cannot crowd the menu out. If something
      // has to be cut it is this: the counts are a convenience, and the menu is
      // the only thing telling a new user what the tool can do.
      const leftWidth = Math.min(Math.max(...left.map(width)) + 3, Math.floor(cols * 0.4));
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
        const cell = truncate(l, leftWidth - 1);
        lines.push(' ' + cell + (m ? ' '.repeat(Math.max(1, leftWidth - width(cell))) + m : ''));
      }
      if (!grid) lines.push(' ' + compactMenu(entries, cols - 3));
      return lines;
    }

    function draw() {
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      if (overlay?.kind === 'help') {
        out.write(CLEAR + helpOverlay(cols, rows).join('\n'));
        return;
      }

      const head = header(cols);
      const previewHeight = showPreview ? Math.min(11, Math.max(5, Math.floor(rows * 0.4))) : 0;
      const chrome = head.length + 4 + (showPreview ? previewHeight + 1 : 0);
      const listHeight = Math.max(3, rows - chrome);
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + listHeight) offset = cursor - listHeight + 1;

      const rule = c.dim('─'.repeat(Math.min(cols - 1, 100)));
      const page = filtered.slice(offset, offset + listHeight);
      const tagCol = tagWidth(page, cols);
      const lines = [...head, rule, renderHeader(cols, tagCol, contextWindow)];
      for (let i = 0; i < listHeight; i++) {
        const s = page[i];
        // The first row of a page always prints its directory, so scrolling
        // never leaves the column blank with nothing above it to inherit from.
        const repeated = i > 0 && page[i - 1] && page[i - 1].cwd === s?.cwd;
        lines.push(s ? renderRow(s, cols, offset + i === cursor, tagCol, repeated, contextWindow) : '');
      }
      lines.push(rule);

      if (showPreview) {
        const panel = renderPreview(filtered[cursor], cols, previewHeight, previewCache);
        for (let i = 0; i < previewHeight; i++) lines.push(panel[i] ?? '');
        lines.push(rule);
      }

      lines.push(
        (mode === 'filter'
          ? c.cyan(' FILTER ') + c.dim('enter keeps it, esc clears it')
          : flash
            ? ' ' + c.green(flash)
            : c.dim(' NORMAL')) +
          (filtered.length ? c.dim(`  [${cursor + 1}/${filtered.length}]`) : c.red('  no match'))
      );
      if (overlay?.kind === 'dialog' || overlay?.kind === 'busy') drawDialog(lines, cols, overlay);
      out.write(CLEAR + lines.join('\n'));
    }

    function onKey(str, key) {
      if (!key) return;
      const enabledFor = (chosen, key) =>
        Boolean(chosen) && menuFor(chosen).find((a) => a.key === key)?.enabled !== false;

      const act = (action, key) => {
        const chosen = filtered[cursor];
        // The menu already dims these, so refusing here is just keeping the two
        // in agreement rather than adding a second, hidden rule.
        if (!enabledFor(chosen, key)) return draw();
        return done({ session: chosen, action });
      };

      /**
       * Run an action and stay in the picker.
       *
       * Handing the terminal over for every action would mean quitting to untag
       * one session and starting again for the next, which is the workflow the
       * rework exists to remove.
       */
      const inPlace = (key, run) => {
        const chosen = filtered[cursor];
        if (!enabledFor(chosen, key)) return draw();
        flash = run(chosen) || '';
        if (actions.reload) {
          const keep = chosen.id;
          pool = actions.reload();
          ordered = sortSessions(pool, sort);
          applyFilter();
          const at = filtered.findIndex((x) => x.id === keep);
          if (at !== -1) cursor = at;
          else if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
        }
        return draw();
      };

      if (key.ctrl && key.name === 'c') return done(null);
      // A box that is working owns the keyboard until it is done. Letting keys
      // through would act on a list the running job is about to change.
      if (overlay?.kind === 'busy') return;
      if (overlay?.kind === 'dialog') {
        const n = overlay.buttons.length;
        if (key.name === 'right' || key.name === 'tab' || key.name === 'l') overlay.at = (overlay.at + 1) % n;
        else if (key.name === 'left' || key.name === 'h') overlay.at = (overlay.at + n - 1) % n;
        else if (key.name === 'escape') overlay = null;
        else if (key.name === 'return' || key.name === 'enter') {
          const chosen = overlay.buttons[overlay.at];
          overlay = null;
          if (chosen.run) chosen.run();
        }
        return draw();
      }
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
      if (key.name === 'return' || key.name === 'enter') return act('resume', 'enter');
      if (key.name === 'f') return act('fork', 'f');
      if (key.name === 'r') return act('remote', 'r');
      if (key.name === 'y') return act('print', 'y');


      flash = '';
      if (key.name === 'n' && !key.ctrl) {
        const chosen = filtered[cursor];
        if (!enabledFor(chosen, 'n')) return draw();
        return askDerive(chosen);
      }
      if (key.name === 'd' && !key.ctrl && actions.untag) {
        const chosen = filtered[cursor];
        if (!enabledFor(chosen, 'd')) return draw();
        overlay = {
          kind: 'dialog',
          title: 'Remove tags',
          body: [
            c.bold(truncate(chosen.label, 52)),
            c.magenta(chosen.tags.map((t) => '#' + t).join(' ')),
            '',
            'The archived copy goes with the last tag.',
          ],
          // Cancel first and focused, as k9s does for anything destructive: the
          // reflex to hit enter should not be the one that deletes.
          buttons: [{ label: 'Cancel' }, { label: 'Remove', run: () => inPlace('d', (sess) => actions.untag(sess)) }],
          at: 0,
        };
      } else if (key.name === 'a' && !key.ctrl && actions.archive) {
        return inPlace('a', (sess) => actions.archive(sess));
      } else if (str === '/') mode = 'filter';
      else if (str === '?') overlay = { kind: 'help' };
      else if (key.name === 'p' && !key.ctrl) showPreview = !showPreview;
      else if (key.name === 't') keepingCursor(() => (tagAt = (tagAt + 1) % tagCycle.length));
      else if (str === '.') keepingCursor(() => (showExpired = !showExpired));
      else if (str === ',') keepingCursor(() => (showUnnamed = !showUnnamed));
      else if (key.name === 'g' && !key.shift && !key.ctrl) keepingCursor(() => (showTree = !showTree));
      else if (key.name === 'u' && !key.ctrl) {
        const parent = filtered[cursor]?.parent;
        const at = parent ? filtered.findIndex((x) => x.id === parent) : -1;
        // The parent may be filtered out of the current view; say so rather
        // than moving the cursor somewhere the user did not ask for.
        if (at !== -1) cursor = at;
        else if (parent) flash = 'the parent is not in this view';
      }
      else if (key.name === 'c' && !key.ctrl) {
        const here = filtered[cursor]?.cwd;
        // Toggling off is unconditional, so a scope narrowed to a directory
        // whose sessions have all been filtered away can still be undone.
        keepingCursor(() => (onlyDir = onlyDir ? null : here || null));
      }
      else if (key.name === 's') {
        keepingCursor(() => {
          sort = SORT_MODES[(SORT_MODES.indexOf(sort) + 1) % SORT_MODES.length];
          ordered = sortSessions(pool, sort);
        });
      } else if (key.name === 'j' || key.name === 'down') cursor = Math.min(last, cursor + 1);
      else if (key.name === 'k' || key.name === 'up') cursor = Math.max(0, cursor - 1);
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
