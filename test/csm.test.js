import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths.js reads CLAUDE_CONFIG_DIR lazily, so every test can point csm at its
// own throwaway config dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
process.env.CLAUDE_CONFIG_DIR = root;

const { width, truncate, pad, relTime } = await import('../src/format.js');
const { encodeProjectPath, projectsDir } = await import('../src/paths.js');
const { parseTranscript, scanSessions, sortSessions } = await import('../src/scan.js');
const { tailMessages } = await import('../src/preview.js');
const { layoutMenu, compactMenu, ACTIONS } = await import('../src/tui.js');
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
