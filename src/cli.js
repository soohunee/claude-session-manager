import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSessions, sortSessions, isUnnamed, SORT_MODES } from './scan.js';
import { loadTags, addTags, removeTags, normalizeTag, ensureHome, readJson } from './store.js';
import { archiveSession, restoreSession, removeArchive, archiveStats } from './archive.js';
import {
  installHooks,
  uninstallHooks,
  hooksInstalled,
  staleHooks,
  installCommand,
  uninstallCommand,
  commandInstalled,
  hookStamp,
  hookEnd,
  resolveCurrentSession,
} from './install.js';
import { recordLink, removeLink, loadLinks, linkedIds, buildTree } from './links.js';
import { extractHandoff, summarizeHandoff, frameHandoff, writeHandoff } from './handoff.js';
import { claudeHome, projectsDir, settingsFile, handoffDir } from './paths.js';
import { pick } from './tui.js';
import { searchTranscript, snippet } from './search.js';
import { c, pad, truncate, relTime, plural, humanBytes, spinner, confirm } from './format.js';

const pkg = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
);

const HELP = `${c.bold('csm')} — claude-sessions-cli v${pkg.version}

Find and resume any Claude Code session, from any directory.

${c.bold('USAGE')}
  csm [query]                 Interactive picker over every session (default)
  csm ls [query]              Print sessions instead of opening the picker
  csm resume <id|query>       Resume directly, skipping the picker
  csm search <text>           Search what was actually said, across every session
  csm derive [id|query]       Start a fresh session carrying a handoff from this one
  csm tree [query]            Show sessions as the tree of what was derived from what
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
      --tagged                Only sessions carrying at least one tag (^a toggles)
  -d, --dir [path]            Only sessions from this directory (default: cwd)
  -n, --limit <n>             Cap the number of sessions shown
  -a, --all                   Everything csm knows of, expired and unnamed included
      --unnamed               Include sessions Claude Code never named (slash commands)
  -s, --sort <time|title|dir> Order sessions (default: time)
  -p, --preview               Open the picker with the preview panel already on
      --remote                Resume with Remote Control, to continue on mobile
      --fork                  Resume into a new session id, leaving the original
      --print-cmd             Print the resume command instead of running it
      --json                  Machine-readable output
      --session <id>          Target this session id, matched on an id prefix
      --fast                  With \`derive\`: build the handoff without asking a model
  -y, --yes                   With \`derive\`: do not ask before spending on the model
      --note <text>           With \`derive\`: extra instructions for the new session
      --model <name>          Model to write the handoff with (default: your usual one)
      --no-archive            With \`tag\`: record the tag but don't archive
      --refresh               Ignore the metadata cache and re-read every file
  -h, --help                  Show this help
  -v, --version               Show version

${c.bold('PICKER KEYS')}
  The picker lists its own keys on screen and dims the ones that do not apply
  to the highlighted session, so there is nothing to memorise. ${c.cyan('?')} shows them
  all. Bare letters act on the session; ${c.cyan('/')} starts filtering.

  Everything the flags above do while browsing has a key: ${c.cyan('t')} tag filter,
  ${c.cyan('.')} expired, ${c.cyan('c')} this directory, ${c.cyan('s')} sort, ${c.cyan('g')} tree, ${c.cyan('n')} derive, ${c.cyan('d')} untag.

${c.bold('EXAMPLES')}
  csm                         Browse everything, fuzzy-search, hit enter to resume
  csm --tagged                Everything you have tagged, whatever the tag
  csm -t billing              Just the sessions you tagged #billing
  csm resume billing          Resume the newest #billing-matching session
  csm resume billing --remote Resume it with Remote Control enabled
  csm search "rate limit"     Find the conversation where you discussed it
  csm ls --dir --json         Sessions for this directory as JSON
  csm derive                  Hand this session's context to a fresh one and open it
  csm tree                    See which sessions grew out of which

Inside Claude Code, ${c.cyan('/persist <tag>')} tags the running session.
`;

export function parseArgs(argv) {
  const opts = { tags: [], dir: null, limit: null, all: false, unnamed: false, json: false, session: null, archive: true, refresh: false, tagged: false, sort: 'time', preview: false, mode: 'resume', print: false, fast: false, yes: false, note: null, model: null };
  const rest = [];
  const passthrough = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else if (a === '-t' || a === '--tag') {
      const value = argv[i + 1];
      // Without this an empty tag silently matches nothing, which reads as
      // "you have no tagged sessions" when in fact the flag was incomplete.
      if (!value || value.startsWith('-')) {
        console.error(c.red(`${a} needs a tag name. Use --tagged for every tagged session.`));
        process.exit(1);
      }
      opts.tags.push(normalizeTag(argv[++i]));
    }
    else if (a === '-d' || a === '--dir') {
      const next = argv[i + 1];
      opts.dir = next && !next.startsWith('-') ? path.resolve(argv[++i]) : process.cwd();
    } else if (a === '-n' || a === '--limit') opts.limit = parseInt(argv[++i], 10) || null;
    else if (a === '-a' || a === '--all') opts.all = opts.unnamed = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--no-archive') opts.archive = false;
    else if (a === '--fast') opts.fast = true;
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '--note') opts.note = argv[++i] || null;
    else if (a === '--model') opts.model = argv[++i] || null;
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '--tagged') opts.tagged = true;
    else if (a === '--unnamed') opts.unnamed = true;
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

export function selectSessions(opts, query) {
  let sessions = scanSessions({ refresh: opts.refresh });
  if (!opts.all) sessions = sessions.filter((s) => s.resumable);
  if (!opts.unnamed) sessions = sessions.filter((s) => !isUnnamed(s));
  if (opts.tagged) sessions = sessions.filter((s) => s.tags.length > 0);
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

/** Indent a derived session under the one it came from. */
export function treePrefix(depth) {
  return depth ? '  '.repeat(depth - 1) + '\u2514 ' : '';
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
      )}${pad(treePrefix(s.depth || 0) + s.label, 48)} ${c.blue(truncate(homeShort(s.cwd), 34))} ${tags}`
    );
  }
}

/**
 * The session a command should act on.
 *
 * `--session` matches on an id prefix, so the eight characters the list prints
 * are enough and nobody has to go looking for the full uuid. An id that matches
 * nothing on disk is still returned as a bare reference, because a tag outlives
 * the session it was attached to and untagging one has to stay possible.
 */
function resolveTarget(opts, query, sessions) {
  if (opts.session) {
    const all = sessions || scanSessions();
    const exact = all.find((s) => s.id === opts.session);
    if (exact) return exact;
    const hits = all.filter((s) => s.id.startsWith(opts.session));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      console.error(c.red(`${opts.session} matches ${hits.length} sessions:`));
      for (const h of hits) console.error(c.dim(`  ${h.id}  ${truncate(h.label, 50)}`));
      process.exit(1);
    }
    return { id: opts.session };
  }
  if (query) {
    const hits = selectSessions({ ...opts, session: null }, query);
    if (!hits.length) {
      console.error(c.red('No session matched.'));
      process.exit(1);
    }
    return hits[0];
  }
  const found = resolveCurrentSession(process.cwd());
  if (!found) return null;
  const all = sessions || scanSessions();
  return all.find((s) => s.id === found.id) || { id: found.id };
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
  const tags = rest.map(normalizeTag).filter(Boolean);
  const target = resolveTarget(opts, null, null);
  if (!target) {
    console.error(c.red('Could not identify a session. Pass --session <id>.'));
    console.error(c.dim('The first eight characters `csm ls` prints are enough.'));
    process.exit(1);
  }
  const id = target.id;
  const entry = removeTags(id, tags);
  if (!entry) {
    console.log(c.dim('That session had no tags.'));
    return;
  }
  const label = target.label ? c.dim(' · ') + truncate(target.label, 40) : '';
  if (entry.tags.length > 0) {
    console.log(
      `${c.yellow('untagged')} ${id.slice(0, 8)}${label} ${c.dim('· still: ')}` +
        entry.tags.map((t) => c.magenta('#' + t)).join(' ')
    );
    return;
  }
  // A session that a tree hangs off keeps its archive even with no tags left:
  // deleting it would strand every session derived from it under a root whose
  // transcript Claude Code has already cleaned up.
  if (linkedIds().has(id)) {
    console.log(`${c.yellow('untagged')} ${id.slice(0, 8)}${label} ${c.dim('· archive kept, it is part of a session tree')}`);
    return;
  }
  removeArchive(id);
  console.log(`${c.yellow('untagged')} ${id.slice(0, 8)}${label} ${c.dim('· archive removed')}`);
}

/**
 * Hand one session's context to a fresh one.
 *
 * This automates what people otherwise do by hand when a conversation fills up:
 * ask it to write down where things stand, open a new session, and point the new
 * one at that document. Doing it here means the link between the two is recorded
 * rather than lost, which is what makes `csm tree` possible.
 */
async function cmdDerive(opts, rest, passthrough) {
  const sessions = scanSessions();
  const parent = resolveTarget(opts, rest.join(' ') || null, sessions);
  if (!parent) {
    console.error(c.red('Could not identify a session in this directory.'));
    console.error(c.dim('Pass --session <id>, or a query that matches one.'));
    process.exit(1);
  }
  if (!parent.cwd) {
    console.error(c.red('That session has no recorded working directory; cannot derive from it.'));
    process.exit(1);
  }
  if (!fs.existsSync(parent.cwd)) {
    console.error(c.red(`Directory no longer exists: ${parent.cwd}`));
    process.exit(1);
  }
  // Summarising resumes the parent, so an archived-only transcript has to be
  // back in place first — the same restore `resume` does.
  if (parent.source === 'archive' || !parent.file || !fs.existsSync(parent.file)) {
    const res = restoreSession(parent);
    if (!res.ok) {
      console.error(c.red(`Cannot derive: ${res.reason}. The transcript is gone.`));
      process.exit(1);
    }
  }

  let text = null;
  let cost = null;
  if (!opts.fast) {
    // Writing the handoff replays the entire parent conversation through the
    // model, so it is billed like the conversation itself. Saying so before
    // spending the money is the difference between a tool and a surprise.
    const size = fs.existsSync(parent.file) ? fs.statSync(parent.file).size : 0;
    console.log(`${c.bold(truncate(parent.label, 50))} ${c.dim(`· ${plural(parent.messages || 0, 'message')} · ${humanBytes(size)}`)}`);
    console.log(
      c.yellow('This asks the session to summarise itself, which re-reads the whole conversation') +
        c.yellow(' in one API call.')
    );
    console.log(c.dim(`It is billed to your Claude account, and a transcript this size is not free.`));
    console.log(c.dim(`${c.cyan('csm derive --fast')} builds the handoff from the transcript instead: instant, free, and`));
    console.log(c.dim('records what happened rather than why.'));
    if (!opts.yes && !(await confirm(c.bold('Write the handoff with the model?')))) {
      console.log(c.dim(process.stdin.isTTY ? 'Stopped. Nothing was spent.' : 'Not a terminal — pass --yes to go ahead, or --fast to skip the model.'));
      return;
    }

    const phases = {
      loading: 'reading the conversation',
      waiting: 'the model is reading it',
      writing: 'writing the handoff',
    };
    const spin = spinner(phases.loading);
    const res = await summarizeHandoff(parent, {
      model: opts.model,
      onPhase: (phase) => spin.update(phases[phase] || phase),
    });
    const took = spin.elapsed();
    spin.stop();
    if (res.ok) {
      text = res.text;
      cost = res.cost;
      console.log(c.green('handoff written') + c.dim(` · ${took}`) + (res.cost != null ? c.dim(` · $${res.cost.toFixed(4)}`) : ''));
    } else {
      console.log(c.yellow(`The model could not summarise it: ${res.reason}`));
      console.log(c.dim('Falling back to a handoff extracted from the transcript.'));
    }
  }
  return finishDerive(parent, passthrough, { text, cost, opts });
}

/**
 * Everything after the handoff exists: write it down, record the lineage, and
 * hand the terminal to Claude Code.
 *
 * Split out because the picker gets here having already asked the question and
 * waited for the summary in its own window, and should not have to repeat
 * either on the way out.
 */
function finishDerive(parent, passthrough, { text = null, cost = null, opts = {} } = {}) {
  const mdPath = writeHandoff(parent.id, text ? frameHandoff(parent, text) : extractHandoff(parent));

  // The parent is now the root of a tree, so it has to outlive Claude Code's
  // cleanup whether or not anyone remembered to tag it.
  archiveSession(parent);

  const child = crypto.randomUUID();
  recordLink(child, parent.id, { handoff: mdPath, cwd: parent.cwd, title: parent.label });

  const seed =
    `A previous session ran out of room, so its context has been handed to you.\n\n` +
    `Read ${mdPath} — it is a handoff document written for exactly this moment — and get up to speed.\n\n` +
    `Then tell me in a few lines what you understand the state of the work to be and what you think comes next. ` +
    `Do not change anything until I say so.` +
    (opts.note ? `\n\n${opts.note}` : '');

  const args = ['--session-id', child, '--add-dir', handoffDir(), ...passthrough, seed];
  if (opts.print) {
    console.log(`cd ${shellQuote(parent.cwd)} && claude --session-id ${child} --add-dir ${shellQuote(handoffDir())} ${shellQuote(seed)}`);
    return;
  }

  console.log(
    `${c.green('derived')} ${c.dim(child.slice(0, 8))} ${c.dim('from')} ${c.dim(parent.id.slice(0, 8))} ` +
      c.dim(`· handoff at ${homeShort(mdPath)}`) +
      (cost != null ? c.dim(` · $${cost.toFixed(4)}`) : '')
  );
  const proc = spawn('claude', args, { cwd: parent.cwd, stdio: 'inherit' });
  proc.on('error', (err) => {
    // Without this the store would keep pointing at a session that was never
    // created, and `csm tree` would grow a permanent phantom branch.
    removeLink(child);
    if (err.code === 'ENOENT') {
      console.error(c.red('`claude` was not found on your PATH.'));
      console.error(c.dim(`The handoff is still at ${mdPath} — open a session yourself and point it there.`));
    } else {
      console.error(c.red(String(err.message)));
    }
    process.exit(127);
  });
  proc.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function cmdTree(opts, rest) {
  const sessions = selectSessions(opts, rest.join(' ') || null);
  const links = loadLinks().links;
  const tree = buildTree(sessions, links);
  if (opts.json) return console.log(JSON.stringify(tree, null, 2));
  printList(tree);
  const derived = tree.filter((s) => s.depth > 0).length;
  const orphans = tree.filter((s) => s.depth === 0 && links[s.id]).length;
  if (!Object.keys(links).length) {
    console.log(c.dim('\nNothing has been derived yet. `csm derive` hands a session to a fresh one.'));
    return;
  }
  console.log(
    c.dim(`\n${plural(derived, 'derived session')} shown`) +
      (orphans ? c.dim(` · ${plural(orphans, 'other')} listed at the top level because the parent is not in view`) : '')
  );
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
  const sessions = scanSessions();
  // A `--print-cmd` derive records the link before the session exists, so a
  // command that was printed and never run leaves a child id nothing will ever
  // create. Drop those first, or they would pin their parent's archive forever.
  // A child that did exist and has since expired is left alone: the tree it
  // belongs to is still a true record of what happened.
  const known = new Set(sessions.map((s) => s.id));
  let phantom = 0;
  for (const child of Object.keys(loadLinks().links)) {
    if (!known.has(child) && removeLink(child)) phantom++;
  }

  const tagged = new Set(Object.keys(loadTags().sessions));
  // Lineage counts as a reason to keep an archive, the same as a tag does.
  const linked = linkedIds();
  const stats = archiveStats();
  let removed = 0;
  let kept = 0;
  for (const s of sessions) {
    if (!s.archived || tagged.has(s.id)) continue;
    if (linked.has(s.id)) {
      kept++;
      continue;
    }
    if (removeArchive(s.id)) removed++;
  }
  const keptNote = kept ? c.dim(` · kept ${plural(kept, 'untagged archive')} held by a session tree`) : '';
  const phantomNote = phantom ? c.dim(` · dropped ${plural(phantom, 'link')} to a session that was never started`) : '';
  console.log(
    (removed
      ? `${c.yellow('pruned')} ${plural(removed, 'archived session')} ${c.dim('with no tags')}`
      : c.dim(`Nothing to prune. Archive holds ${plural(stats.count, 'session')}.`)) + keptNote + phantomNote
  );
}

function cmdInit() {
  ensureHome();
  const hooks = installHooks();
  const cmd = installCommand();
  console.log(c.bold('csm is wired up.'));
  if (hooks.added.length) console.log(`  ${c.green('+')} hooks installed: ${hooks.added.join(', ')}`);
  if (hooks.updated.length) console.log(`  ${c.green('~')} hooks updated: ${hooks.updated.join(', ')}`);
  if (!hooks.added.length && !hooks.updated.length) console.log(`  ${c.dim('=')} hooks already up to date`);
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
  const stale = staleHooks();
  console.log(
    `  hooks           ${hooksInstalled().join(', ') || c.red('not installed')}` +
      (stale.length ? c.red(`  (${stale.length} pointing at a missing interpreter)`) : '')
  );
  for (const h of stale) {
    console.log(c.red(`    ${h.event} runs ${homeShort(h.interpreter)}, which no longer exists.`));
    console.log(c.dim('    Re-run `csm init` to point it at the current one.'));
  }
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
  const links = loadLinks().links;
  const derived = Object.keys(links).length;
  console.log(`  derived         ${derived}${derived ? c.dim('  (see `csm tree`)') : ''}`);

  if (expired > 0) {
    console.log('');
    console.log(c.yellow('  Claude Code deletes transcripts after cleanupPeriodDays') + c.dim(` (currently ${cleanup ?? 30}, the default).`));
    console.log(c.dim('  Tagged sessions are copied into csm’s archive and survive that.'));
    if (cleanup === undefined) {
      console.log(c.dim(`  To keep everything longer, set "cleanupPeriodDays" in ${homeShort(settingsFile())}.`));
    }
  }
}

function cmdSearch(opts, rest) {
  const query = rest.join(' ');
  if (!query) {
    console.error(c.red('Usage: csm search <text>'));
    process.exit(1);
  }
  // The limit caps sessions reported, not sessions searched, so `-n 5` still
  // looks everywhere and just stops printing.
  const sessions = selectSessions({ ...opts, limit: null }, null).filter((s) => s.file);
  const results = [];
  for (const s of sessions) {
    const hits = searchTranscript(s.file, query, { limit: 3 });
    if (hits.length) results.push({ session: s, hits });
    if (opts.limit && results.length >= opts.limit) break;
  }

  if (opts.json) {
    return console.log(
      JSON.stringify(
        results.map((r) => ({ ...r.session, matches: r.hits.map((h) => ({ role: h.role, text: h.text })) })),
        null,
        2
      )
    );
  }
  if (!results.length) {
    console.log(c.dim(`Nothing matched ${JSON.stringify(query)} in ${plural(sessions.length, 'session')}.`));
    return;
  }

  const cols = process.stdout.columns || 100;
  for (const { session: s, hits } of results) {
    const tags = (s.tags || []).map((t) => c.magenta('#' + t)).join(' ');
    console.log(
      `${c.dim(s.id.slice(0, 8))} ${c.dim(pad(relTime(s.updatedAt), 9))}${pad(s.label, 44)} ${c.blue(
        truncate(homeShort(s.cwd), 30)
      )} ${tags}`
    );
    for (const hit of hits) {
      const win = snippet(hit, Math.max(30, cols - 8));
      const marked =
        win.text.slice(0, win.at) +
        c.yellow(win.text.slice(win.at, win.at + win.length)) +
        win.text.slice(win.at + win.length);
      console.log(`   ${hit.role === 'user' ? c.cyan('›') : c.dim('‹')} ${marked}`);
    }
  }
  console.log(
    c.dim(`\n${plural(results.length, 'session')} matched · resume one with `) + c.cyan('csm resume <id>')
  );
}

async function cmdPick(opts, rest, passthrough) {
  const query = rest.join(' ');
  // Expired, tagged and directory are toggles inside the picker now, so the
  // pool it gets must still contain everything they can bring back. Applying
  // them here would leave a key that can hide but never restore.
  const pool = selectSessions({ ...opts, all: true, unnamed: true, tagged: false, dir: null }, null);
  const sessions = pool;
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
  // Only what narrows the view goes in the header; naming the tool twice would
  // spend a line of chrome saying nothing.
  const scope = [];
  if (opts.tags.length) scope.push(opts.tags.map((t) => '#' + t).join(' '));
  if (opts.dir) scope.push(homeShort(opts.dir));
  if (opts.all) scope.push('including expired');
  const subtitle = expired && !opts.all ? `${expired} expired` : '';
  // The picker owns no storage of its own: it is handed the operations it may
  // perform, so it stays a renderer and the rules about archives live in one
  // place. Each returns the line to flash in the footer.
  const reload = () => selectSessions({ ...opts, tagged: false }, null);
  const actions = {
    reload,
    untag(session) {
      removeTags(session.id, []);
      if (linkedIds().has(session.id)) return `untagged ${session.id.slice(0, 8)} · archive kept, it is part of a session tree`;
      const gone = removeArchive(session.id);
      return `untagged ${session.id.slice(0, 8)}${gone ? ' · archive removed' : ''}`;
    },
    archive(session) {
      const res = archiveSession(session);
      if (!res.ok) return `could not archive: ${res.reason}`;
      return res.skipped ? 'archive already up to date' : `archived ${humanBytes(res.bytes)}`;
    },
    // Handed in so the picker can ask the question and show the wait in its own
    // window, without reaching into how a handoff is actually written.
    summarize(session, onPhase) {
      if (session.source === 'archive' || !session.file || !fs.existsSync(session.file)) restoreSession(session);
      return summarizeHandoff(session, { model: opts.model, onPhase });
    },
  };

  const chosen = await pick(pool, {
    actions,
    scope: scope.join('  '),
    version: pkg.version,
    subtitle,
    query,
    preview: opts.preview,
    sort: opts.sort,
    expired: opts.all,
    unnamed: opts.unnamed,
    dir: opts.dir,
    tag: opts.tags.length === 1 ? opts.tags[0] : opts.tagged ? '*' : null,
  });
  if (!chosen) {
    if (!process.stdout.isTTY) printList(sessions);
    return;
  }
  // Deriving is its own command rather than a way of resuming, so it does not
  // go through the mode below.
  if (chosen.action === 'derive') {
    if (chosen.warning) console.log(c.yellow(`The model could not summarise it: ${chosen.warning}`) + c.dim(' — using the transcript instead.'));
    return finishDerive(chosen.session, passthrough, {
      text: chosen.handoff?.text ?? null,
      cost: chosen.handoff?.cost ?? null,
      opts,
    });
  }
  // A key pressed in the picker refines what the flags asked for: `r` and `f`
  // choose the mode, `y` only switches the result to a printed command.
  const mode = chosen.action === 'remote' || chosen.action === 'fork' ? chosen.action : opts.mode;
  resume(chosen.session, passthrough, { mode, print: opts.print || chosen.action === 'print' });
}

export async function main(argv) {
  const { opts, rest, passthrough } = parseArgs(argv);
  if (opts.version) return console.log(pkg.version);
  const command = rest[0];

  if (command === 'hook-stamp' || command === 'hook-end') {
    // Never fail loudly: a hook must not block the user's prompt or delay a
    // session closing, whatever state csm's own files are in.
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try {
      const payload = JSON.parse(raw || '{}');
      if (command === 'hook-stamp') hookStamp(payload);
      else hookEnd(payload);
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
    case 'search':
      return cmdSearch(opts, rest.slice(1));
    case 'derive':
      return cmdDerive(opts, rest.slice(1), passthrough);
    case 'tree':
      return cmdTree(opts, rest.slice(1));
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
