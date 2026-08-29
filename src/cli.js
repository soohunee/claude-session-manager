import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSessions, sortSessions, SORT_MODES } from './scan.js';
import { loadTags, addTags, removeTags, normalizeTag, ensureHome, readJson } from './store.js';
import { archiveSession, restoreSession, removeArchive, archiveStats, humanBytes, isArchived } from './archive.js';
import {
  installHooks,
  uninstallHooks,
  hooksInstalled,
  installCommand,
  uninstallCommand,
  commandInstalled,
  hookStamp,
  resolveCurrentSession,
} from './install.js';
import { claudeHome, projectsDir, settingsFile } from './paths.js';
import { pick } from './tui.js';
import { c, pad, truncate, relTime, plural } from './format.js';

const pkg = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
);

const HELP = `${c.bold('csm')} — claude-sessions-cli v${pkg.version}

Find and resume any Claude Code session, from any directory.

${c.bold('USAGE')}
  csm [query]                 Interactive picker over every session (default)
  csm ls [query]              Print sessions instead of opening the picker
  csm resume <id|query>       Resume directly, skipping the picker
  csm tag <tag...>            Tag the session in this directory and archive it
  csm untag <tag...>          Remove tags (omit tags to clear the session)
  csm tags                    List every tag with its session count
  csm archive                 Archive all tagged sessions now
  csm prune                   Delete archives of sessions that are no longer tagged
  csm init                    Install the /persist command and session hooks
  csm uninstall               Remove them again
  csm doctor                  Show what csm sees and whether it is wired up

${c.bold('OPTIONS')}
  -t, --tag <tag>             Only sessions carrying this tag (repeatable)
  -d, --dir [path]            Only sessions from this directory (default: cwd)
  -n, --limit <n>             Cap the number of sessions shown
  -a, --all                   Include expired sessions with no transcript left
  -s, --sort <time|title|dir> Order sessions (default: time)
  -p, --preview               Open the picker with the preview panel already on
      --remote                Resume with Remote Control, to continue on mobile
      --fork                  Resume into a new session id, leaving the original
      --print-cmd             Print the resume command instead of running it
      --json                  Machine-readable output
      --session <id>          Target this session id instead of the current one
      --no-archive            With \`tag\`: record the tag but don't archive
      --refresh               Ignore the metadata cache and re-read every file
  -h, --help                  Show this help
  -v, --version               Show version

${c.bold('PICKER KEYS')}
  ↑↓ / ^p ^n                  Move            tab       Toggle the preview panel
  enter                       Resume          ^r        Resume with Remote Control
  ^y                          Print command   ^f        Resume as a fork
  ^t / ^o / ^g                Sort by time / title / directory
  ^u                          Clear query     esc       Quit

${c.bold('EXAMPLES')}
  csm                         Browse everything, fuzzy-search, hit enter to resume
  csm -t billing              Just the sessions you tagged #billing
  csm resume billing          Resume the newest #billing-matching session
  csm resume billing --remote Resume it with Remote Control enabled
  csm ls --dir --json         Sessions for this directory as JSON

Inside Claude Code, ${c.cyan('/persist <tag>')} tags the running session.
`;

function parseArgs(argv) {
  const opts = { tags: [], dir: null, limit: null, all: false, json: false, session: null, archive: true, refresh: false, sort: 'time', preview: false, mode: 'resume', print: false };
  const rest = [];
  const passthrough = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else if (a === '-t' || a === '--tag') opts.tags.push(normalizeTag(argv[++i] || ''));
    else if (a === '-d' || a === '--dir') {
      const next = argv[i + 1];
      opts.dir = next && !next.startsWith('-') ? path.resolve(argv[++i]) : process.cwd();
    } else if (a === '-n' || a === '--limit') opts.limit = parseInt(argv[++i], 10) || null;
    else if (a === '-a' || a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--no-archive') opts.archive = false;
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '-s' || a === '--sort') {
      const mode = argv[++i];
      if (!SORT_MODES.includes(mode)) {
        console.error(c.red(`Unknown sort mode: ${mode}. Use one of ${SORT_MODES.join(', ')}.`));
        process.exit(1);
      }
      opts.sort = mode;
    } else if (a === '-p' || a === '--preview') opts.preview = true;
    else if (a === '--remote') opts.mode = 'remote';
    else if (a === '--fork') opts.mode = 'fork';
    else if (a === '--print-cmd') opts.print = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else rest.push(a);
  }
  return { opts, rest, passthrough };
}

function selectSessions(opts, query) {
  let sessions = scanSessions({ refresh: opts.refresh });
  if (!opts.all) sessions = sessions.filter((s) => s.resumable);
  if (opts.tags.length) sessions = sessions.filter((s) => opts.tags.every((t) => s.tags.includes(t)));
  if (opts.dir) sessions = sessions.filter((s) => s.cwd === opts.dir);
  if (query) {
    const q = query.toLowerCase();
    sessions = sessions.filter((s) =>
      [s.label, s.cwd, s.id, ...(s.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }
  sessions = sortSessions(sessions, opts.sort);
  if (opts.limit) sessions = sessions.slice(0, opts.limit);
  return sessions;
}

function homeShort(p) {
  const home = process.env.HOME;
  return home && p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '?';
}

function printList(sessions) {
  if (!sessions.length) {
    console.log(c.dim('No sessions matched.'));
    return;
  }
  for (const s of sessions) {
    const tags = (s.tags || []).map((t) => c.magenta('#' + t)).join(' ');
    const flag = s.resumable ? (s.archived ? c.green('A') : ' ') : c.red('x');
    console.log(
      `${flag} ${c.dim(s.id.slice(0, 8))} ${c.dim(pad(relTime(s.updatedAt), 9))}${pad(
        s.messages ? String(s.messages) : '-',
        5
      )}${pad(s.label, 48)} ${c.blue(truncate(homeShort(s.cwd), 34))} ${tags}`
    );
  }
}

/** Single-quote a path for a shell command the user will paste back. */
function shellQuote(value) {
  return `'` + String(value).replace(/'/g, `'\\''`) + `'`;
}

/**
 * Restore from archive if needed, then hand the terminal over to Claude Code.
 *
 * `mode` selects what handing over means: resume in place, resume with Remote
 * Control so the conversation can continue on mobile, or resume as a fork that
 * leaves the original untouched. `print` is orthogonal to all three — it emits
 * the command that would have run and exits.
 */
function resume(session, passthrough, { mode = 'resume', print = false } = {}) {
  if (!session.cwd) {
    console.error(c.red('This session has no recorded working directory; cannot resume.'));
    process.exit(1);
  }
  if (!fs.existsSync(session.cwd)) {
    console.error(c.red(`Directory no longer exists: ${session.cwd}`));
    process.exit(1);
  }
  if (session.source === 'archive' || !session.file || !fs.existsSync(session.file)) {
    const res = restoreSession(session);
    if (!res.ok) {
      console.error(c.red(`Cannot resume: ${res.reason}. The transcript is gone.`));
      process.exit(1);
    }
    if (!res.skipped) console.log(c.dim(`Restored archived transcript into ${homeShort(path.dirname(res.restoredTo))}`));
  }

  const args = ['--resume', session.id];
  if (mode === 'fork') args.push('--fork-session');
  if (mode === 'remote') args.push('--remote-control');
  args.push(...passthrough);

  // Printing happens after any restore, so the command still works if the
  // transcript only existed in the archive when csm was asked for it.
  if (print) {
    console.log(`cd ${shellQuote(session.cwd)} && claude ${args.join(' ')}`);
    return;
  }

  const note = mode === 'fork' ? c.dim(' (fork)') : mode === 'remote' ? c.dim(' (remote control)') : '';
  console.log(c.dim(`→ ${homeShort(session.cwd)}  ${c.bold(session.label)}`) + note);
  const child = spawn('claude', args, {
    cwd: session.cwd,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(c.red('`claude` was not found on your PATH.'));
      console.error(c.dim(`Run it yourself with:  cd ${shellQuote(session.cwd)} && claude ${args.join(' ')}`));
    } else {
      console.error(c.red(String(err.message)));
    }
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function cmdTag(opts, rest) {
  const tags = rest.map(normalizeTag).filter(Boolean);
  if (!tags.length) {
    console.error(c.red('Usage: csm tag <tag> [more-tags...]'));
    process.exit(1);
  }
  let id = opts.session;
  let via = 'flag';
  if (!id) {
    const found = resolveCurrentSession(process.cwd());
    if (!found) {
      console.error(c.red('Could not identify a session in this directory.'));
      console.error(c.dim('Run `csm init` to install the session hook, or pass --session <id>.'));
      process.exit(1);
    }
    id = found.id;
    via = found.via;
  }
  const all = scanSessions();
  const session = all.find((s) => s.id === id);
  addTags(id, tags, { cwd: session?.cwd, title: session?.label });

  let archived = '';
  if (opts.archive && session?.file) {
    const res = archiveSession(session);
    if (res.ok && !res.skipped) archived = c.dim(` · archived ${humanBytes(res.bytes)}`);
    else if (res.ok) archived = c.dim(' · archive up to date');
  }
  const label = session ? truncate(session.label, 40) : id.slice(0, 8);
  console.log(
    `${c.green('tagged')} ${tags.map((t) => c.magenta('#' + t)).join(' ')} → ${c.bold(label)}${archived}` +
      (via === 'mtime' ? c.dim('  (matched by recency; run `csm init` for exact matching)') : '')
  );
}

function cmdUntag(opts, rest) {
  const id = opts.session || resolveCurrentSession(process.cwd())?.id;
  if (!id) {
    console.error(c.red('Could not identify a session. Pass --session <id>.'));
    process.exit(1);
  }
  const tags = rest.map(normalizeTag).filter(Boolean);
  const entry = removeTags(id, tags);
  if (!entry) {
    console.log(c.dim('That session had no tags.'));
    return;
  }
  if (entry.tags.length === 0) {
    removeArchive(id);
    console.log(`${c.yellow('untagged')} ${id.slice(0, 8)} ${c.dim('· archive removed')}`);
  } else {
    console.log(`${c.yellow('untagged')} ${id.slice(0, 8)} ${c.dim('· still: ')}${entry.tags.map((t) => c.magenta('#' + t)).join(' ')}`);
  }
}

function cmdTags() {
  const sessions = scanSessions();
  const counts = new Map();
  for (const s of sessions) for (const t of s.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (!counts.size) {
    console.log(c.dim('No tags yet. Use `/persist <tag>` inside Claude Code, or `csm tag <tag>`.'));
    return;
  }
  for (const [tag, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${c.magenta('#' + pad(tag, 24))} ${c.dim(plural(n, 'session'))}`);
  }
}

function cmdArchive() {
  const sessions = scanSessions().filter((s) => s.tags.length && s.file);
  if (!sessions.length) {
    console.log(c.dim('Nothing tagged to archive.'));
    return;
  }
  let saved = 0;
  let count = 0;
  for (const s of sessions) {
    const res = archiveSession(s);
    if (res.ok && !res.skipped) {
      saved += res.bytes;
      count++;
    }
  }
  const stats = archiveStats();
  console.log(
    `${c.green('archived')} ${plural(count, 'new session')} ${c.dim(`(${humanBytes(saved)})`)} · ` +
      c.dim(`archive now holds ${plural(stats.count, 'session')}, ${humanBytes(stats.bytes)}`)
  );
}

function cmdPrune() {
  const tagged = new Set(Object.keys(loadTags().sessions));
  const stats = archiveStats();
  let removed = 0;
  const sessions = scanSessions();
  for (const s of sessions) {
    if (s.archived && !tagged.has(s.id) && removeArchive(s.id)) removed++;
  }
  console.log(
    removed
      ? `${c.yellow('pruned')} ${plural(removed, 'archived session')} ${c.dim('with no tags')}`
      : c.dim(`Nothing to prune. Archive holds ${plural(stats.count, 'session')}.`)
  );
}

function cmdInit() {
  ensureHome();
  const hooks = installHooks();
  const cmd = installCommand();
  console.log(c.bold('csm is wired up.'));
  console.log(
    hooks.added.length
      ? `  ${c.green('+')} hooks installed: ${hooks.added.join(', ')}`
      : `  ${c.dim('=')} hooks already installed`
  );
  if (hooks.backup) console.log(c.dim(`      settings backed up to ${homeShort(hooks.backup)}`));
  console.log(`  ${c.green('+')} slash command: ${homeShort(cmd)}  ${c.dim('→ /persist <tag>')}`);
  console.log(c.dim('\nRestart Claude Code (or start a new session) for the hooks to take effect.'));
}

function cmdUninstall() {
  const hooks = uninstallHooks();
  const cmd = uninstallCommand();
  console.log(
    `${c.yellow('removed')} hooks: ${hooks.removed.join(', ') || 'none'} · /persist: ${cmd ? 'yes' : 'not installed'}`
  );
  console.log(c.dim(`Tags and archives are untouched. Delete ${homeShort(path.join(claudeHome(), 'csm'))} to remove them.`));
}

function cmdDoctor() {
  const sessions = scanSessions({ refresh: true });
  const resumable = sessions.filter((s) => s.resumable);
  const expired = sessions.length - resumable.length;
  const dirs = new Set(sessions.map((s) => s.cwd).filter(Boolean));
  const tagged = sessions.filter((s) => s.tags.length);
  const stats = archiveStats();
  const settings = readJson(settingsFile(), {}) || {};
  const cleanup = settings.cleanupPeriodDays;
  const current = resolveCurrentSession(process.cwd());

  const ok = (b) => (b ? c.green('ok') : c.red('missing'));
  console.log(c.bold('csm doctor') + c.dim(` v${pkg.version}`));
  console.log(`  claude home     ${homeShort(claudeHome())} ${ok(fs.existsSync(projectsDir()))}`);
  console.log(`  hooks           ${hooksInstalled().join(', ') || c.red('not installed')}`);
  console.log(`  /persist        ${ok(commandInstalled())}`);
  console.log(`  this directory  ${current ? `${current.id.slice(0, 8)} ${c.dim('via ' + current.via)}` : c.dim('no session found')}`);
  console.log('');
  console.log(`  sessions        ${sessions.length} across ${plural(dirs.size, 'directory', 'directories')}`);
  console.log(`  resumable       ${resumable.length}`);
  console.log(
    `  expired         ${expired}${expired ? c.dim('  (transcript deleted by Claude Code cleanup)') : ''}`
  );
  console.log(`  tagged          ${tagged.length}`);
  console.log(`  archive         ${plural(stats.count, 'session')}, ${humanBytes(stats.bytes)}`);

  if (expired > 0) {
    console.log('');
    console.log(c.yellow('  Claude Code deletes transcripts after cleanupPeriodDays') + c.dim(` (currently ${cleanup ?? 30}, the default).`));
    console.log(c.dim('  Tagged sessions are copied into csm’s archive and survive that.'));
    if (cleanup === undefined) {
      console.log(c.dim(`  To keep everything longer, set "cleanupPeriodDays" in ${homeShort(settingsFile())}.`));
    }
  }
}

async function cmdPick(opts, rest, passthrough) {
  const query = rest.join(' ');
  const sessions = selectSessions(opts, null);
  // Count against everything on disk, not the filtered view, so the header
  // never claims there are no expired sessions when it simply hid them.
  const total = scanSessions();
  const expired = total.filter((s) => !s.resumable).length;
  if (opts.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  if (!sessions.length) {
    console.log(c.dim('No sessions found. Have you used Claude Code in this account yet?'));
    return;
  }
  const titleBits = ['Claude sessions'];
  if (opts.tags.length) titleBits.push(opts.tags.map((t) => '#' + t).join(' '));
  if (opts.dir) titleBits.push(homeShort(opts.dir));
  const subtitle =
    `${plural(sessions.length, 'session')} shown` +
    (expired && !opts.all ? ` · ${expired} expired, transcript gone (-a to list)` : '');
  const chosen = await pick(sessions, {
    title: titleBits.join('  '),
    subtitle,
    query,
    preview: opts.preview,
    sort: opts.sort,
  });
  if (!chosen) {
    if (!process.stdout.isTTY) printList(sessions);
    return;
  }
  // A key pressed in the picker refines what the flags asked for: ^r and ^f
  // choose the mode, ^y only switches the result to a printed command.
  const mode = chosen.action === 'remote' || chosen.action === 'fork' ? chosen.action : opts.mode;
  resume(chosen.session, passthrough, { mode, print: opts.print || chosen.action === 'print' });
}

export async function main(argv) {
  const { opts, rest, passthrough } = parseArgs(argv);
  if (opts.version) return console.log(pkg.version);
  const command = rest[0];

  if (command === 'hook-stamp') {
    // Never fail loudly: a broken stamp must not block the user's prompt.
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try {
      hookStamp(JSON.parse(raw || '{}'));
    } catch {
      /* ignore */
    }
    return;
  }
  if (opts.help || command === 'help') return console.log(HELP);

  switch (command) {
    case 'init':
      return cmdInit();
    case 'uninstall':
      return cmdUninstall();
    case 'doctor':
      return cmdDoctor();
    case 'tag':
      return cmdTag(opts, rest.slice(1));
    case 'untag':
      return cmdUntag(opts, rest.slice(1));
    case 'tags':
      return cmdTags();
    case 'archive':
      return cmdArchive();
    case 'prune':
      return cmdPrune();
    case 'ls':
    case 'list': {
      const sessions = selectSessions(opts, rest.slice(1).join(' ') || null);
      if (opts.json) return console.log(JSON.stringify(sessions, null, 2));
      return printList(sessions);
    }
    case 'resume': {
      const sessions = selectSessions(opts, rest.slice(1).join(' ') || null);
      if (!sessions.length) {
        console.error(c.red('No session matched.'));
        process.exit(1);
      }
      return resume(sessions[0], passthrough, { mode: opts.mode, print: opts.print });
    }
    case 'all':
      return cmdPick(opts, rest.slice(1), passthrough);
    default:
      return cmdPick(opts, rest, passthrough);
  }
}
