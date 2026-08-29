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
const { parseTranscript, scanSessions } = await import('../src/scan.js');
const { addTags, removeTags, loadTags, normalizeTag } = await import('../src/store.js');
const { archiveSession, restoreSession, isArchived } = await import('../src/archive.js');
const { installHooks, uninstallHooks, hooksInstalled } = await import('../src/install.js');

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
  assert.deepEqual(first.added, ['SessionStart', 'UserPromptSubmit']);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus', 'unrelated settings are untouched');
  assert.deepEqual(after.hooks.Stop, original.hooks.Stop, 'unrelated hook events are untouched');
  assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'other.sh', 'existing entries keep their position');
  assert.equal(after.hooks.SessionStart.length, 2);

  assert.deepEqual(installHooks().added, [], 'installing twice adds nothing');
  assert.deepEqual(hooksInstalled(), ['SessionStart', 'UserPromptSubmit']);

  uninstallHooks();
  const cleaned = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(cleaned.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(cleaned.hooks.SessionStart, original.hooks.SessionStart, 'uninstall restores the original shape');
  assert.equal(cleaned.hooks.UserPromptSubmit, undefined, 'an emptied event is removed entirely');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
