import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// paths.js reads CLAUDE_CONFIG_DIR lazily, so every test can point csm at its
// own throwaway config dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
process.env.CLAUDE_CONFIG_DIR = root;

// format.js decides once, at import, whether to emit colour. Under a test
// runner stdout is not a terminal, which would leave every escape sequence out
// and quietly turn the colour assertions below into assertions about nothing.
process.stdout.isTTY = true;
delete process.env.NO_COLOR;

const { width, truncate, pad, relTime, c } = await import('../src/format.js');
const { encodeProjectPath, projectsDir } = await import('../src/paths.js');
const { parseTranscript, scanSessions, sortSessions, isUnnamed } = await import('../src/scan.js');
const { tailMessages } = await import('../src/preview.js');
const { pick, layoutMenu, compactMenu, menuFor, shortPath, ACTIONS } = await import('../src/tui.js');
const { searchTranscript, snippet } = await import('../src/search.js');
const { parseArgs, selectSessions } = await import('../src/cli.js');
const { addTags, removeTags, loadTags, normalizeTag } = await import('../src/store.js');
const { archiveSession, restoreSession, isArchived, archivePathFor } = await import('../src/archive.js');
const { installHooks, uninstallHooks, hooksInstalled, hookEnd, staleHooks } = await import('../src/install.js');
const { recordLink, removeLink, loadLinks, linkedIds, buildTree } = await import('../src/links.js');
const { extractHandoff, frameHandoff } = await import('../src/handoff.js');

const CWD = '/tmp/csm-fixture-project';

function writeTranscript(id, lines, dir = path.join(projectsDir(), encodeProjectPath(CWD))) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function fixtureLines(title, prompt) {
  return [
    { type: 'last-prompt', sessionId: 'x' },
    { type: 'user', cwd: CWD, gitBranch: 'main', version: '2.0.0', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: prompt } },
    { type: 'assistant', cwd: CWD, timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] } },
    { type: 'user', cwd: CWD, isSidechain: true, timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'user', content: 'subagent noise' } },
    { type: 'ai-title', aiTitle: title, sessionId: 'x' },
  ];
}

test('width and truncation account for wide characters', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('한글'), 4);
  assert.equal(width('a한b'), 4);
  assert.equal(width(truncate('한글 제목이 아주 길어지는 경우', 10)) <= 10, true);
  assert.equal(width(pad('한글', 10)), 10);
  assert.equal(width(pad('this string is far too long', 10)), 10);
});

test('relTime renders coarse buckets', () => {
  assert.equal(relTime(new Date().toISOString()), 'just now');
  assert.equal(relTime(new Date(Date.now() - 3 * 86400000).toISOString()), '3d ago');
  assert.equal(relTime(null), '?');
  assert.equal(relTime('not a date'), '?');
});

test('project paths encode every non-alphanumeric character as a dash', () => {
  assert.equal(encodeProjectPath('/Users/me/Desktop/dev'), '-Users-me-Desktop-dev');
  assert.equal(encodeProjectPath('/a/b_c.d'), '-a-b-c-d');
});

test('parseTranscript pulls title, cwd and message counts, ignoring sidechains', () => {
  const file = writeTranscript('11111111-1111-1111-1111-111111111111', fixtureLines('Fixture title', 'hello there'));
  const meta = parseTranscript(file);
  assert.equal(meta.title, 'Fixture title');
  assert.equal(meta.cwd, CWD);
  assert.equal(meta.gitBranch, 'main');
  assert.equal(meta.firstPrompt, 'hello there');
  assert.equal(meta.messages, 2, 'sidechain messages must not be counted');
  assert.equal(meta.lastSeen, '2026-01-01T00:02:00.000Z');
});

test('parseTranscript returns null for a file that does not exist', () => {
  assert.equal(parseTranscript(path.join(root, 'nope.jsonl')), null);
});

test('scanSessions lists transcripts and marks history-only sessions unresumable', () => {
  writeTranscript('22222222-2222-2222-2222-222222222222', fixtureLines('Live session', 'still here'));
  fs.writeFileSync(
    path.join(root, 'history.jsonl'),
    [
      { display: 'a prompt', project: CWD, sessionId: '22222222-2222-2222-2222-222222222222', timestamp: Date.now() },
      { display: 'long gone', project: '/tmp/other-project', sessionId: '99999999-9999-9999-9999-999999999999', timestamp: Date.now() - 86400000 },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
  const sessions = scanSessions({ refresh: true });
  const live = sessions.find((s) => s.id.startsWith('22222222'));
  const gone = sessions.find((s) => s.id.startsWith('99999999'));
  assert.equal(live.resumable, true);
  assert.equal(live.label, 'Live session');
  assert.equal(gone.resumable, false, 'a session with no transcript cannot be resumed');
  assert.equal(gone.cwd, '/tmp/other-project', 'history.jsonl is the only record of its directory');
});

test('the metadata cache returns the same result as a cold read', () => {
  const cold = scanSessions({ refresh: true });
  const warm = scanSessions();
  assert.deepEqual(
    warm.map((s) => [s.id, s.label, s.messages]),
    cold.map((s) => [s.id, s.label, s.messages])
  );
});

test('tags are normalized, merged and removable', () => {
  const id = '33333333-3333-3333-3333-333333333333';
  addTags(id, ['Billing Refactor', '#urgent']);
  assert.deepEqual(loadTags().sessions[id].tags, ['billing-refactor', 'urgent']);
  addTags(id, ['urgent', 'later']);
  assert.deepEqual(loadTags().sessions[id].tags, ['billing-refactor', 'later', 'urgent']);
  removeTags(id, ['urgent']);
  assert.deepEqual(loadTags().sessions[id].tags, ['billing-refactor', 'later']);
  removeTags(id, null);
  assert.equal(loadTags().sessions[id], undefined, 'clearing all tags drops the entry');
  assert.equal(normalizeTag('  Mixed Case '), 'mixed-case');
});

test('an archived session survives Claude Code deleting its transcript', () => {
  const id = '44444444-4444-4444-4444-444444444444';
  const file = writeTranscript(id, fixtureLines('Important work', 'do the thing'));
  const before = fs.readFileSync(file, 'utf8');

  const session = scanSessions({ refresh: true }).find((s) => s.id === id);
  assert.equal(archiveSession(session).ok, true);
  assert.equal(isArchived(id), true);

  fs.unlinkSync(file); // Claude Code's cleanupPeriodDays sweep
  const afterDelete = scanSessions({ refresh: true }).find((s) => s.id === id);
  assert.equal(afterDelete.resumable, true, 'archive keeps it resumable');
  assert.equal(afterDelete.source, 'archive');

  assert.equal(restoreSession(afterDelete).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'restored transcript is byte-identical');
});

test('archiving is idempotent and skips work when already current', () => {
  const id = '44444444-4444-4444-4444-444444444444';
  const session = scanSessions({ refresh: true }).find((s) => s.id === id);
  const second = archiveSession(session);
  assert.equal(second.ok, true);
  assert.ok(second.skipped, 'a second archive of unchanged content is a no-op');
});

test('installHooks preserves existing hooks and is idempotent', () => {
  const settings = path.join(root, 'settings.json');
  const original = {
    model: 'opus',
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'other.sh' }] }],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(original));

  const first = installHooks();
  assert.deepEqual(first.added, ['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus', 'unrelated settings are untouched');
  assert.deepEqual(after.hooks.Stop, original.hooks.Stop, 'unrelated hook events are untouched');
  assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'other.sh', 'existing entries keep their position');
  assert.equal(after.hooks.SessionStart.length, 2);

  const second = installHooks();
  assert.deepEqual(second.added, [], 'installing twice adds nothing');
  assert.deepEqual(second.updated, [], 'installing twice rewrites nothing');
  assert.deepEqual(hooksInstalled(), ['SessionStart', 'UserPromptSubmit', 'SessionEnd']);

  // The guard has to sit before the marker comment, or the shell swallows it
  // and a csm failure could block the user's prompt.
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionEnd']) {
    const ours = JSON.parse(fs.readFileSync(settings, 'utf8'))
      .hooks[event].flatMap((g) => g.hooks)
      .find((h) => h.command.includes('csm-hook'));
    assert.match(ours.command, /\|\| true #/, `${event} guard runs outside the comment`);
  }

  uninstallHooks();
  const cleaned = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(cleaned.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(cleaned.hooks.SessionStart, original.hooks.SessionStart, 'uninstall restores the original shape');
  assert.equal(cleaned.hooks.UserPromptSubmit, undefined, 'an emptied event is removed entirely');
  assert.equal(cleaned.hooks.SessionEnd, undefined);
});

test('installHooks repairs a hook left behind by an older version', () => {
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        SessionStart: [
          // The 0.1.0 shape: the guard is stranded inside the comment.
          { matcher: '', hooks: [{ type: 'command', command: 'node csm.js hook-stamp # csm-hook-stamp || true' }] },
        ],
      },
    })
  );

  const res = installHooks();
  assert.deepEqual(res.updated, ['SessionStart'], 'the stale command is rewritten in place');
  assert.deepEqual(res.added, ['UserPromptSubmit', 'SessionEnd']);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 1, 'no duplicate entry is appended');
  assert.match(after.hooks.SessionStart[0].hooks[0].command, /\|\| true # csm-hook$/);

  uninstallHooks();
});

test('the SessionEnd hook re-archives a tagged session, and ignores untagged ones', () => {
  const file = writeTranscript('end-hook', fixtureLines('Tagged work', 'first prompt'));

  // Untagged: nothing is written, because csm only keeps what you asked it to.
  assert.equal(hookEnd({ session_id: 'end-hook', transcript_path: file }), false);
  assert.equal(isArchived('end-hook'), false);

  addTags('end-hook', ['keep']);
  assert.equal(hookEnd({ session_id: 'end-hook', transcript_path: file }), true);
  const snapshot = fs.readFileSync(archivePathFor('end-hook'), 'utf8');

  // Messages sent after the tag land in the archive when the session closes,
  // which is the whole point: tagging alone only captures a snapshot.
  fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd: CWD, timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'user', content: 'said after tagging' } }) + '\n');
  assert.equal(hookEnd({ session_id: 'end-hook', transcript_path: file }), true);
  const updated = fs.readFileSync(archivePathFor('end-hook'), 'utf8');
  assert.equal(updated.length > snapshot.length, true);
  assert.match(updated, /said after tagging/);

  // With no usable transcript path it falls back to the encoded project dir.
  assert.equal(hookEnd({ session_id: 'end-hook', cwd: CWD }), true);
  assert.equal(hookEnd({ session_id: 'end-hook', cwd: '/nowhere' }), false);
  assert.equal(hookEnd({}), false);

  removeTags('end-hook', []);
});

test('searchTranscript matches visible text and ignores metadata and noise', () => {
  const file = writeTranscript('search-1', [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'how do we handle the RATE limit?' } },
    { type: 'assistant', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Back off and retry the rate limit.' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'rate limit in a subagent' } },
    // The needle appears only in a field the reader never sees.
    { type: 'assistant', gitBranch: 'rate-limit-fix', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated reply' }] } },
  ]);

  const hits = searchTranscript(file, 'rate limit', { limit: 10 });
  assert.deepEqual(hits.map((h) => h.role), ['user', 'assistant'], 'sidechains and metadata-only lines are skipped');
  assert.match(hits[0].text, /RATE limit/, 'matching is case-insensitive');
  assert.equal(hits[0].text.slice(hits[0].at, hits[0].at + hits[0].length).toLowerCase(), 'rate limit');

  assert.deepEqual(searchTranscript(file, 'rate limit', { limit: 1 }).length, 1);
  assert.deepEqual(searchTranscript(file, 'nothing here at all'), []);
  assert.deepEqual(searchTranscript(path.join(root, 'missing.jsonl'), 'x'), []);
});

test('searchTranscript still finds a needle that JSON encoding would escape', () => {
  const file = writeTranscript('search-2', [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'he said "ship it" yesterday' } },
  ]);
  // A quoted needle cannot be found by scanning the raw line, so the fast path
  // has to step aside rather than report no match.
  const hits = searchTranscript(file, '"ship it"');
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /ship it/);
});

test('snippet centres the match and measures the window in terminal cells', () => {
  const long = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200);
  const win = snippet({ text: long, at: 200, length: 6 }, 40);
  assert.equal(width(win.text) <= 42, true, 'the window respects its budget');
  assert.equal(win.text.slice(win.at, win.at + win.length), 'NEEDLE');
  assert.equal(win.text.startsWith('…') && win.text.endsWith('…'), true);

  // Wide characters cost two cells each, so half as many of them fit.
  const korean = '한'.repeat(100) + 'NEEDLE' + '글'.repeat(100);
  const wide = snippet({ text: korean, at: 100, length: 6 }, 40);
  assert.equal(width(wide.text) <= 42, true);
  assert.equal(wide.text.slice(wide.at, wide.at + wide.length), 'NEEDLE');

  // A short line needs no window at all and keeps its exact text.
  const whole = snippet({ text: 'just NEEDLE here', at: 5, length: 6 }, 80);
  assert.equal(whole.text, 'just NEEDLE here');
  assert.equal(whole.text.slice(whole.at, whole.at + whole.length), 'NEEDLE');
});

test('staleHooks reports a hook whose pinned interpreter is gone', () => {
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, '{}');
  installHooks();
  assert.deepEqual(staleHooks(), [], 'a fresh install points at a real interpreter');

  const broken = JSON.parse(fs.readFileSync(settings, 'utf8'));
  broken.hooks.SessionEnd[0].hooks[0].command =
    '"/gone/bin/node" "/x/csm.js" hook-end || true # csm-hook';
  fs.writeFileSync(settings, JSON.stringify(broken));
  assert.deepEqual(staleHooks(), [{ event: 'SessionEnd', interpreter: '/gone/bin/node' }]);

  // init repairs it in place rather than appending a second entry.
  assert.deepEqual(installHooks().updated, ['SessionEnd']);
  assert.deepEqual(staleHooks(), []);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.SessionEnd.length, 1);

  uninstallHooks();
});

test('--tagged selects every tagged session, --tag selects one', () => {
  writeTranscript('filter-a', fixtureLines('Alpha', 'alpha prompt'));
  writeTranscript('filter-b', fixtureLines('Beta', 'beta prompt'));
  writeTranscript('filter-c', fixtureLines('Gamma', 'gamma prompt'));
  addTags('filter-a', ['billing']);
  addTags('filter-b', ['scratch']);

  const ids = (opts) =>
    selectSessions({ ...parseArgs([]).opts, ...opts, refresh: true }, null)
      .map((s) => s.id)
      .filter((id) => id.startsWith('filter-'))
      .sort();

  assert.deepEqual(ids({}), ['filter-a', 'filter-b', 'filter-c'], 'no filter shows everything');
  assert.deepEqual(ids({ tagged: true }), ['filter-a', 'filter-b'], 'any tag, whichever it is');
  assert.deepEqual(ids({ tags: ['billing'] }), ['filter-a']);
  // Combining the two narrows rather than widens.
  assert.deepEqual(ids({ tagged: true, tags: ['billing'] }), ['filter-a']);
  assert.deepEqual(ids({ tags: ['billing', 'scratch'] }), [], 'repeated --tag is AND');

  removeTags('filter-a', []);
  removeTags('filter-b', []);
  assert.deepEqual(ids({ tagged: true }), [], 'nothing is tagged once the tags are cleared');
});

test('parseArgs reads the tag filters', () => {
  assert.equal(parseArgs(['--tagged']).opts.tagged, true);
  assert.equal(parseArgs([]).opts.tagged, false);
  assert.deepEqual(parseArgs(['-t', 'Billing', '--tag', 'ops']).opts.tags, ['billing', 'ops']);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('sortSessions orders by time, title and directory', () => {
  const sessions = [
    { id: 'a', label: 'beta', cwd: '/z', updatedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'b', label: 'alpha', cwd: '/a', updatedAt: '2026-01-03T00:00:00.000Z' },
    { id: 'c', label: 'gamma', cwd: null, updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(sortSessions(sessions, 'time').map((s) => s.id), ['b', 'a', 'c']);
  assert.deepEqual(sortSessions(sessions, 'title').map((s) => s.id), ['b', 'a', 'c']);
  // Sessions with no recorded directory sort last rather than under an empty key.
  assert.deepEqual(sortSessions(sessions, 'dir').map((s) => s.id), ['b', 'a', 'c']);
  // The input is never mutated, so the picker can re-sort the same array.
  assert.deepEqual(sessions.map((s) => s.id), ['a', 'b', 'c']);
});

test('sortSessions falls back to recency within an equal key', () => {
  const sessions = [
    { id: 'old', label: 'same', cwd: '/p', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', label: 'same', cwd: '/p', updatedAt: '2026-06-01T00:00:00.000Z' },
  ];
  assert.deepEqual(sortSessions(sessions, 'title').map((s) => s.id), ['new', 'old']);
  assert.deepEqual(sortSessions(sessions, 'dir').map((s) => s.id), ['new', 'old']);
});

test('tailMessages returns the last readable turns and skips noise', () => {
  const file = writeTranscript('preview-1', [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first question' } },
    { type: 'assistant', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent noise' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>tool output</local-command-stdout>' } },
    { type: 'user', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'user', content: 'second\n  question' } },
  ]);
  const msgs = tailMessages(file, { limit: 10 });
  assert.deepEqual(msgs, [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
    // Newlines and runs of spaces collapse so a turn stays on one preview row.
    { role: 'user', text: 'second question' },
  ]);
  assert.deepEqual(tailMessages(file, { limit: 1 }), [{ role: 'user', text: 'second question' }]);
});

test('tailMessages reads only the tail and drops the partial first record', () => {
  const filler = Array.from({ length: 200 }, (_, i) => ({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'padding '.repeat(40) + i }] },
  }));
  const file = writeTranscript('preview-2', [
    ...filler,
    { type: 'user', timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'user', content: 'the very last prompt' } },
  ]);
  // A window far smaller than the file forces a seek into the middle of a line.
  const msgs = tailMessages(file, { limit: 3, bytes: 2048 });
  assert.equal(msgs.at(-1).text, 'the very last prompt');
  assert.equal(msgs.length <= 3, true);
  for (const m of msgs) assert.equal(m.text.includes('{'), false);
});

test('tailMessages survives a missing file', () => {
  assert.deepEqual(tailMessages(path.join(root, 'nope.jsonl')), []);
});

test('lineage survives a session losing its last tag', () => {
  addTags('parent-a', ['keepme']);
  recordLink('child-a', 'parent-a', { title: 'the parent' });
  removeTags('parent-a', []);
  assert.equal(loadTags().sessions['parent-a'], undefined);
  // The link store is separate precisely so untagging cannot take it out.
  assert.equal(loadLinks().links['child-a'].parent, 'parent-a');
  assert.deepEqual([...linkedIds()].sort(), ['child-a', 'parent-a']);
  removeLink('child-a');
  assert.equal(loadLinks().links['child-a'], undefined);
});

test('recordLink refuses a self-link and removeLink reports a miss', () => {
  assert.equal(recordLink('same', 'same'), null);
  assert.equal(recordLink('only-child', null), null);
  assert.equal(removeLink('never-existed'), false);
});

test('buildTree nests children and promotes the ones whose parent is out of view', () => {
  const links = {
    kid: { parent: 'root' },
    grandkid: { parent: 'kid' },
    orphan: { parent: 'gone' },
  };
  const sessions = ['root', 'kid', 'grandkid', 'orphan', 'loner'].map((id) => ({ id }));
  const tree = buildTree(sessions, links);
  assert.deepEqual(
    tree.map((s) => [s.id, s.depth]),
    [['root', 0], ['kid', 1], ['grandkid', 2], ['orphan', 0], ['loner', 0]]
  );
});

test('buildTree survives a cycle in a hand-edited store', () => {
  const links = { a: { parent: 'b' }, b: { parent: 'a' } };
  const tree = buildTree([{ id: 'a' }, { id: 'b' }], links);
  assert.equal(tree.length, 2);
  assert.deepEqual(tree.map((s) => s.id).sort(), ['a', 'b']);
});

test('a derived session is labelled after its parent, not the handoff boilerplate', () => {
  const seed = 'A previous session ran out of room, so its context has been handed to you.';
  writeTranscript('derived-1', [
    { type: 'user', cwd: CWD, timestamp: '2026-02-01T00:00:00.000Z', message: { role: 'user', content: seed } },
  ]);
  recordLink('derived-1', 'parent-b', { title: 'the original work' });
  const found = scanSessions({ refresh: true }).find((s) => s.id === 'derived-1');
  assert.equal(found.parent, 'parent-b');
  assert.equal(found.label, '\u2191 the original work');
  removeLink('derived-1');
});

test('extractHandoff records what was asked and done without a model', () => {
  const file = writeTranscript('handoff-src', [
    { type: 'user', cwd: CWD, timestamp: '2026-03-01T00:00:00.000Z', message: { role: 'user', content: 'fix the parser' } },
    { type: 'user', cwd: CWD, timestamp: '2026-03-01T00:00:30.000Z', message: { role: 'user', content: '<command-name>/noise</command-name>' } },
    {
      type: 'assistant',
      cwd: CWD,
      timestamp: '2026-03-01T00:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/parser.js' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test\nsecond line' } },
        ],
      },
    },
  ]);
  const md = extractHandoff({ id: 'handoff-src', label: 'Parser work', cwd: CWD, file, messages: 3 });
  assert.match(md, /^# Handoff — Parser work/);
  assert.match(md, /fix the parser/);
  assert.match(md, /\/src\/parser\.js/);
  assert.match(md, /npm test/);
  assert.match(md, /Edit 1×/);
  // The command envelope is noise, and only the first line of a command is kept.
  assert.equal(md.includes('command-name'), false);
  assert.equal(md.includes('second line'), false);
});

test('frameHandoff drops the heading the model writes for itself', () => {
  const framed = frameHandoff(
    { id: 'p1', label: 'Real title', cwd: CWD },
    '# Session Handoff — something\n\n## Goal\n\nship it'
  );
  assert.match(framed, /^# Handoff — Real title/);
  assert.equal(framed.includes('# Session Handoff'), false);
  assert.match(framed, /## Goal/);
  assert.match(framed, /ship it/);
  // Exactly one top-level heading survives.
  assert.equal(framed.split('\n').filter((l) => /^# /.test(l)).length, 1);
});

test('parseArgs reads the derive flags', () => {
  const { opts } = parseArgs(['derive', '--fast', '--note', 'keep going', '--model', 'haiku']);
  assert.equal(opts.fast, true);
  assert.equal(opts.note, 'keep going');
  assert.equal(opts.model, 'haiku');
});

test('width and truncate ignore colour escapes', () => {
  const red = '\u001b[31m';
  const reset = '\u001b[0m';
  assert.equal(width(red + 'abcde' + reset), 5);
  // Cutting a coloured string must not count the escapes as visible cells, or a
  // painted line disappears long before the edge of the terminal.
  assert.equal(width(truncate(red + 'abcdefghij' + reset, 5)), 5);
  // …and it must close the colour it opened.
  assert.equal(truncate(red + 'abcdefghij' + reset, 5).endsWith(reset), true);
  assert.equal(truncate('abcdefghij', 5), 'abcd\u2026');
});

test('the key menu drops columns rather than truncating a label', () => {
  const wide = layoutMenu(ACTIONS, 120);
  const narrow = layoutMenu(ACTIONS, 30);
  assert.ok(narrow.length > wide.length, 'a narrow menu should be taller');
  for (const lines of [wide, narrow]) {
    const text = lines.join('\n');
    assert.equal(text.includes('\u2026'), false, 'no label may be cut');
    for (const a of ACTIONS) assert.ok(text.includes(a.label), `${a.label} must stay listed`);
  }
});

test('the key menu fits the width it is given', () => {
  for (const avail of [120, 80, 60, 40, 20]) {
    for (const line of layoutMenu(ACTIONS, avail)) {
      assert.ok(width(line) <= avail, `a ${avail}-cell menu produced a ${width(line)}-cell line`);
    }
  }
  assert.deepEqual(layoutMenu(ACTIONS, 4), [], 'too narrow for anything gives nothing');
});

test('the compact menu always says how to see the rest', () => {
  for (const avail of [80, 40, 20, 8]) {
    const line = compactMenu(ACTIONS, avail);
    assert.match(line, /More keys/);
    assert.equal(line.includes('\u2026'), false);
  }
  assert.ok(width(compactMenu(ACTIONS, 80)) > width(compactMenu(ACTIONS, 30)));
});

test('the menu answers what can be done with the highlighted session', () => {
  const live = menuFor({ resumable: true, file: 'x', cwd: CWD, tags: ['keep'], parent: 'p0' });
  const expired = menuFor({ resumable: false, cwd: CWD, tags: ['keep'], parent: 'p0' });
  const on = (menu, key) => menu.find((a) => a.key === key).enabled !== false;
  assert.deepEqual(ACTIONS.filter((a) => a.needs).map((a) => a.key), ['enter', 'f', 'r', 'y', 'n', 'd', 'a', 'c', 'u']);

  // A live, tagged session can take everything.
  for (const a of live) assert.notEqual(a.enabled, false, `${a.key} should be live`);
  // An expired one has no transcript, so it cannot be resumed or archived, but
  // its tags are still csm's own and can still be dropped.
  for (const key of ['enter', 'f', 'r', 'y', 'n', 'a']) {
    assert.equal(on(expired, key), false, `${key} needs a transcript`);
  }
  assert.equal(on(expired, 'd'), true, 'tags outlive the transcript');
  // Keys that act on the view, not the session, never go dim.
  for (const key of ['/', 's', 't', '.', 'g', 'p', '?', 'esc']) {
    assert.equal(on(expired, key), true, `${key} should not depend on the session`);
  }
  assert.equal(on(menuFor({ resumable: true, file: 'x', tags: [] }), 'd'), false, 'nothing to untag');
  assert.equal(on(menuFor({ resumable: true, file: 'x', archived: true, tags: [] }), 'a'), false, 'already archived');
  assert.equal(on(menuFor({ resumable: true, file: 'x', tags: [] }), 'c'), false, 'no directory to narrow to');
  assert.equal(on(menuFor({ resumable: true, file: 'x', cwd: CWD, tags: [] }), 'u'), false, 'nothing to go up to');
  assert.equal(on(menuFor({ resumable: true, file: 'x', cwd: CWD, tags: [], parent: 'p1' }), 'u'), true);
  // An empty list still produces a readable menu rather than throwing.
  assert.equal(on(menuFor(undefined), 'enter'), false);
});

test('a disabled key is dimmed as one piece', () => {
  assert.notEqual(c.dim('x'), 'x', 'colour must be on for this to test anything');
  const [line] = layoutMenu([{ key: 'x', label: 'Nope', enabled: false }], 40);
  const [live] = layoutMenu([{ key: 'x', label: 'Yep' }], 40);
  // Bold inside dim does not survive: the reset closing the bold closes the dim
  // with it, and the label comes back at full brightness.
  assert.equal(line, c.dim('x  Nope'));
  assert.equal(line.includes('\u001b[1m'), false);
  assert.equal(live, c.bold('x') + '  Yep');
});

/**
 * Drive the picker with a scripted list of keypresses.
 *
 * The picker reads process.stdin and process.stdout directly, so the only way
 * to exercise the parts that matter — refusing an action the menu has dimmed,
 * and staying open after one that acts in place — is to stand in for both and
 * put them back afterwards.
 */
async function drivePicker(sessions, keys, { actions = {}, cols = 100, rows = 24, ...rest } = {}) {
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const { write, columns, rows: realRows } = process.stdout;
  const frames = [];
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  // Capture only what the picker draws. Swallowing every write would eat the
  // test runner's own reporting, which happens during the await below and made
  // a full suite report as a single test.
  const mine = /\u001b\[(2J|\?1049|\?25)/;
  process.stdout.write = (chunk) => {
    const text = String(chunk);
    if (!mine.test(text)) return write.call(process.stdout, chunk);
    frames.push(text);
    return true;
  };
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  try {
    const pending = pick(sessions, { actions, ...rest });
    for (const k of keys) stdin.emit('keypress', k.str ?? null, k);
    // Snapshot before yielding. Every draw is synchronous, but the moment this
    // awaits, the test runner's own writes land in `frames` too.
    const screen = (frames[frames.length - 1] || '').replace(/\u001b\[[0-9;]*m/g, '');
    // Nothing resolves unless a key asked it to, so race the promise against a
    // turn of the loop rather than hanging when the picker is still open.
    const result = await Promise.race([pending, new Promise((r) => setImmediate(() => r('still-open')))]);
    // Close a picker that is still open, so it takes its resize listener off
    // the real stdout. Doing it before the restore keeps the escape codes it
    // writes on the way out from reaching the terminal.
    stdin.emit('keypress', null, { name: 'escape' });
    return { result, screen };
  } finally {
    Object.defineProperty(process, 'stdin', realStdin);
    process.stdout.write = write;
    process.stdout.columns = columns;
    process.stdout.rows = realRows;
  }
}

const LIVE = { id: 'live0000-0000', label: 'Live one', title: 'Live one', cwd: CWD, resumable: true, file: '/x', tags: ['keep'], updatedAt: '2026-01-02T00:00:00.000Z', messages: 3 };
const EXPIRED = { id: 'gone0000-0000', label: 'Expired one', title: 'Expired one', cwd: CWD, resumable: false, file: null, tags: [], updatedAt: '2026-01-01T00:00:00.000Z', messages: 1 };

test('the picker resumes the highlighted session', async () => {
  const { result } = await drivePicker([LIVE, EXPIRED], [{ name: 'return' }]);
  assert.equal(result.action, 'resume');
  assert.equal(result.session.id, LIVE.id);
});

test('the picker refuses an action its menu has dimmed', async () => {
  // Cursor down onto the expired session, then try every key that needs a
  // transcript. Each must be ignored rather than handing over a session with
  // nothing left to resume.
  for (const key of [{ name: 'return' }, { name: 'f' }, { name: 'r' }, { name: 'y' }]) {
    const { result } = await drivePicker([LIVE, EXPIRED], [{ name: 'j' }, key], { expired: true });
    assert.equal(result, 'still-open', `${key.name} should have been refused`);
  }
  const { result } = await drivePicker([LIVE, EXPIRED], [{ name: 'j' }, { name: 'escape' }], { expired: true });
  assert.equal(result, null, 'escape still quits');
});

test('untagging asks first, and only y goes through', async () => {
  let called = 0;
  const actions = { untag: () => (called++, 'untagged'), reload: () => [LIVE] };

  const asked = await drivePicker([LIVE], [{ name: 'd' }], { actions });
  assert.match(asked.screen, /Remove tags\?/);
  assert.match(asked.screen, /y to remove/);
  assert.equal(called, 0, 'nothing happens until the question is answered');

  await drivePicker([LIVE], [{ name: 'd' }, { str: 'n', name: 'n' }], { actions });
  assert.equal(called, 0, 'any key other than y cancels');

  const done = await drivePicker([LIVE], [{ name: 'd' }, { str: 'y', name: 'y' }], { actions });
  assert.equal(called, 1);
  assert.equal(done.result, 'still-open', 'the picker stays open after acting');
  assert.match(done.screen, /untagged/, 'and says what it did');
});

test('an in-place action reloads the list without losing the cursor', async () => {
  const after = [{ ...LIVE, tags: [] }, EXPIRED];
  let reloaded = 0;
  const actions = { archive: () => 'archived 1KB', reload: () => (reloaded++, after) };
  const { result, screen } = await drivePicker([LIVE, EXPIRED], [{ name: 'a' }], { actions });
  assert.equal(reloaded, 1);
  assert.equal(result, 'still-open');
  assert.match(screen, /archived 1KB/);
  // Still on the session that was acted on, not reset to the top.
  assert.match(screen, /^> .*Live one/m);
});

test('the picker hides expired sessions until asked, and can bring them back', async () => {
  const off = await drivePicker([LIVE, EXPIRED], []);
  assert.equal(off.screen.includes('Expired one'), false, 'hidden by default');
  const on = await drivePicker([LIVE, EXPIRED], [{ str: '.' }]);
  assert.match(on.screen, /Expired one/);
  assert.match(on.screen, /expired/, 'and the state block says so');
  // The same key puts them away again, so the toggle is not one-way.
  const back = await drivePicker([LIVE, EXPIRED], [{ str: '.' }, { str: '.' }]);
  assert.equal(back.screen.includes('Expired one'), false);
});

test('the tag key cycles off, any tag, then each tag in turn', async () => {
  const a = { ...LIVE, id: 'a', label: 'Has billing', tags: ['billing'] };
  const b = { ...LIVE, id: 'b', label: 'Has ops', tags: ['ops'] };
  const none = { ...LIVE, id: 'n', label: 'Has none', tags: [] };
  const press = (n) => drivePicker([a, b, none], Array.from({ length: n }, () => ({ name: 't' })));

  const off = await press(0);
  for (const l of ['Has billing', 'Has ops', 'Has none']) assert.match(off.screen, new RegExp(l));

  const any = await press(1);
  assert.equal(any.screen.includes('Has none'), false, 'any tag excludes the untagged');

  const billing = await press(2);
  assert.match(billing.screen, /Has billing/);
  assert.equal(billing.screen.includes('Has ops'), false);
  assert.match(billing.screen, /#billing/, 'the state block names the tag');

  const ops = await press(3);
  assert.match(ops.screen, /Has ops/);
  assert.equal(ops.screen.includes('Has billing'), false);

  // Round trips back to showing everything rather than dead-ending.
  const wrapped = await press(4);
  for (const l of ['Has billing', 'Has ops', 'Has none']) assert.match(wrapped.screen, new RegExp(l));
});

test('narrowing to a directory can always be undone', async () => {
  const here = { ...LIVE, id: 'h', label: 'In here', cwd: '/tmp/here' };
  const there = { ...LIVE, id: 't', label: 'Over there', cwd: '/tmp/there' };
  const narrowed = await drivePicker([here, there], [{ name: 'c' }]);
  assert.match(narrowed.screen, /In here/);
  assert.equal(narrowed.screen.includes('Over there'), false);
  const widened = await drivePicker([here, there], [{ name: 'c' }, { name: 'c' }]);
  assert.match(widened.screen, /Over there/);
});

test('the picker nests derived sessions and can jump to a parent', async () => {
  const root = { ...LIVE, id: 'root', label: 'The original', tags: [], parent: null };
  const kid = { ...LIVE, id: 'kid', label: 'Carried on', tags: [], parent: 'root', updatedAt: '2026-01-03T00:00:00.000Z' };
  recordLink('kid', 'root');

  // Flat, the child sorts above its parent by recency and reads as unrelated.
  const flat = await drivePicker([kid, root], []);
  assert.equal(/Carried on[\s\S]*The original/.test(flat.screen), true);
  assert.equal(flat.screen.includes('\u2514 Carried on'), false);

  const tree = await drivePicker([kid, root], [{ name: 'g' }]);
  assert.match(tree.screen, /The original[\s\S]*\u2514 Carried on/, 'the child hangs off its parent');
  assert.match(tree.screen, /tree/, 'and the state block says so');

  // From the child, `u` moves the cursor onto the parent.
  const jumped = await drivePicker([kid, root], [{ name: 'g' }, { name: 'j' }, { name: 'u' }]);
  assert.match(jumped.screen, /^> .*The original/m);

  // With the parent filtered out, the jump says so instead of moving somewhere
  // the user did not ask for.
  const alone = await drivePicker([kid], [{ name: 'u' }]);
  assert.match(alone.screen, /parent is not in this view/);
  removeLink('kid');
});

test('a path is shortened from the front, so the project name survives', () => {
  const home = process.env.HOME;
  const p = `${home}/Desktop/develop/claude-session-manager`;
  assert.equal(shortPath(p, 60), '~/Desktop/develop/claude-session-manager');
  // Cutting from the end would leave "~/Desktop/develop/claude-sess…", which
  // says nothing about which project this is.
  const cut = shortPath(p, 26);
  assert.equal(cut, '\u2026/claude-session-manager');
  assert.ok(width(cut) <= 26);
  // Keeps adding parents while they fit.
  assert.equal(shortPath(p, 34), '\u2026/develop/claude-session-manager');
  // A single segment too long for the column still has to fit it.
  assert.ok(width(shortPath('/a-very-long-single-directory-name', 12)) <= 12);
});

test('every key in the menu explains itself', () => {
  for (const a of ACTIONS) {
    assert.ok(a.help && a.help.length > 10, `${a.key} needs a help line`);
    assert.notEqual(a.help.toLowerCase(), a.label.toLowerCase(), `${a.key} help must add something`);
  }
  // Resume and its copy are the pair people cannot tell apart, so each has to
  // say what happens to the original.
  const fork = ACTIONS.find((a) => a.key === 'f');
  assert.match(fork.label + ' ' + fork.help, /copy|branch/i);
  assert.match(fork.help, /leaving this one|original/i);
});

test('the picker prints a directory once per run of rows that share it', async () => {
  const here = { ...LIVE, id: '1', label: 'One', cwd: '/tmp/same', tags: [] };
  const also = { ...LIVE, id: '2', label: 'Two', cwd: '/tmp/same', tags: [], updatedAt: '2026-01-01T00:00:00.000Z' };
  const other = { ...LIVE, id: '3', label: 'Three', cwd: '/tmp/other', tags: [], updatedAt: '2025-12-31T00:00:00.000Z' };
  const { screen } = await drivePicker([here, also, other], []);
  const rows = screen.split('\n').filter((l) => /One|Two|Three/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /same/, 'the first row of a run carries the directory');
  assert.equal(/same|other/.test(rows[1]), false, 'the repeat is left blank');
  assert.match(rows[2], /other/, 'a new directory starts a new run');
});

test('a session Claude Code never named counts as unnamed, once it has had time to be', () => {
  const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  assert.equal(isUnnamed({ title: null, updatedAt: old }), true);
  assert.equal(isUnnamed({ title: 'Billing refactor', updatedAt: old }), false, 'a title is the whole signal');
  // The grace period is the point: hiding the session someone just closed,
  // because Claude Code has not titled it yet, would be the worst possible miss.
  assert.equal(isUnnamed({ title: null, updatedAt: now }), false);
  assert.equal(isUnnamed(undefined), false);
  assert.equal(isUnnamed({ title: null, updatedAt: null }), true, 'no timestamp is not recent');
  // A session csm derived is one someone deliberately started; Claude Code will
  // not have titled it yet, but it is the opposite of a leftover.
  assert.equal(isUnnamed({ title: null, parent: 'root', updatedAt: old }), false);
});

test('listings hide unnamed sessions unless asked', () => {
  writeTranscript('named-1', fixtureLines('Real work', 'do the thing'));
  writeTranscript('unnamed-1', [
    { type: 'user', cwd: CWD, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '/plugins' } },
  ]);
  const plain = selectSessions({ ...parseArgs([]).opts, refresh: true }, null).map((x) => x.id);
  assert.ok(plain.includes('named-1'));
  assert.equal(plain.includes('unnamed-1'), false);

  for (const argv of [['--unnamed'], ['-a']]) {
    const shown = selectSessions(parseArgs(argv).opts, null).map((x) => x.id);
    assert.ok(shown.includes('unnamed-1'), `${argv} should bring it back`);
  }
});

test('the picker hides unnamed sessions, says how many, and can show them', async () => {
  const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  const named = { ...LIVE, id: 'n1', label: 'Real work', title: 'Real work', tags: [], updatedAt: old };
  const bare = { ...LIVE, id: 'u1', label: '/plugins', title: null, tags: [], updatedAt: old };

  const hidden = await drivePicker([named, bare], []);
  assert.match(hidden.screen, /Real work/);
  assert.equal(hidden.screen.includes('/plugins'), false);
  // A filter that silently drops rows is indistinguishable from a bug.
  assert.match(hidden.screen, /1 unnamed hidden/);

  const shown = await drivePicker([named, bare], [{ str: ',' }]);
  assert.match(shown.screen, /\/plugins/);
  assert.equal(shown.screen.includes('unnamed hidden'), false);
});

test('the list is labelled, and the labels line up with the rows', async () => {
  const { screen } = await drivePicker([LIVE, { ...LIVE, id: 'b', label: 'Second' }], []);
  const header = screen.split('\n').find((l) => /\bwhen\b/.test(l));
  assert.ok(header, 'the list needs a header');
  for (const label of ['when', 'msgs', 'title', 'directory']) assert.match(header, new RegExp(label));
  const row = screen.split('\n').find((l) => /Live one/.test(l));
  // The header is computed from the same widths as the row, so the title starts
  // in the same cell on both.
  assert.equal(header.indexOf('title'), row.indexOf('Live one'));
});

test('deriving asks inside the picker and offers the free route', async () => {
  let summarised = 0;
  const actions = { summarize: () => (summarised++, Promise.resolve({ ok: true, text: 'done', cost: 0.1 })) };

  const asked = await drivePicker([LIVE], [{ name: 'n' }], { actions });
  assert.match(asked.screen, /New session from this one/);
  // The box wraps, so assert on phrases a line break cannot split.
  assert.match(asked.screen, /one API call/, 'it must say what it is about to do');
  assert.match(asked.screen, /billed to your/, 'it must say it costs money');
  assert.match(asked.screen, /y model . f transcript/);
  assert.equal(summarised, 0, 'nothing runs until the question is answered');

  // Any other key cancels, so `n` cannot spend money by itself.
  const cancelled = await drivePicker([LIVE], [{ name: 'n' }, { str: 'x', name: 'x' }], { actions });
  assert.equal(summarised, 0);
  assert.equal(cancelled.result, 'still-open');

  // `f` skips the model entirely and leaves with no handoff to carry.
  const fast = await drivePicker([LIVE], [{ name: 'n' }, { str: 'f', name: 'f' }], { actions });
  assert.equal(summarised, 0, 'the fast route never reaches the model');
  assert.equal(fast.result.action, 'derive');
  assert.equal(fast.result.handoff, null);
});

test('a failed summary still derives, from the transcript', async () => {
  const actions = { summarize: () => Promise.resolve({ ok: false, reason: 'context too long' }) };
  const { result } = await drivePicker([LIVE], [{ name: 'n' }, { str: 'y', name: 'y' }], { actions });
  // Stopping here would throw away a decision the user has already made.
  assert.equal(result.action, 'derive');
  assert.equal(result.handoff, null);
  assert.equal(result.warning, 'context too long');
});
