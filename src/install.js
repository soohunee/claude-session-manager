import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { settingsFile, commandsDir, currentDir, projectsDir, encodeProjectPath } from './paths.js';
import { readJson, writeJson, tagsFor } from './store.js';
import { archiveSession } from './archive.js';

// Deliberately a prefix of the older `csm-hook-stamp` marker, so hooks written
// by an earlier version are still recognised and can be repaired or removed.
const MARKER = 'csm-hook';

const HOOK_SPECS = [
  { event: 'SessionStart', sub: 'hook-stamp' },
  { event: 'UserPromptSubmit', sub: 'hook-stamp' },
  // Re-archives a tagged session as it closes, so the archive holds the whole
  // conversation rather than a snapshot from the moment it was tagged.
  { event: 'SessionEnd', sub: 'hook-end' },
];
const HOOK_EVENTS = HOOK_SPECS.map((h) => h.event);

function binPath() {
  return path.resolve(fileURLToPath(new URL('../bin/csm.js', import.meta.url)));
}

function hookCommand(sub) {
  // Quoted so a space in the install path can't split the command. `|| true`
  // has to come *before* the marker: everything after `#` is a comment, so a
  // guard written behind it would never run and a csm failure could block the
  // user's prompt.
  return `"${process.execPath}" "${binPath()}" ${sub} || true # ${MARKER}`;
}

function hasOurHook(entries) {
  return (entries || []).some((group) =>
    (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER))
  );
}

export function installHooks() {
  const file = settingsFile();
  const settings = readJson(file, {}) || {};
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.csm-backup');
  }
  settings.hooks = settings.hooks || {};
  const added = [];
  const updated = [];
  for (const { event, sub } of HOOK_SPECS) {
    settings.hooks[event] = settings.hooks[event] || [];
    const want = hookCommand(sub);
    // Rewrite a stale command in place rather than skipping it, so an install
    // from an older version is repaired instead of left half-broken.
    let found = false;
    for (const group of settings.hooks[event]) {
      for (const h of group.hooks || []) {
        if (typeof h.command !== 'string' || !h.command.includes(MARKER)) continue;
        found = true;
        if (h.command !== want) {
          h.command = want;
          if (!updated.includes(event)) updated.push(event);
        }
      }
    }
    if (found) continue;
    settings.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command: want }],
    });
    added.push(event);
  }
  if (added.length || updated.length) writeJson(file, settings);
  return {
    added,
    updated,
    backup: fs.existsSync(file + '.csm-backup') ? file + '.csm-backup' : null,
  };
}

export function uninstallHooks() {
  const file = settingsFile();
  const settings = readJson(file, null);
  if (!settings?.hooks) return { removed: [] };
  const removed = [];
  for (const event of HOOK_EVENTS) {
    const before = settings.hooks[event];
    if (!Array.isArray(before)) continue;
    const after = before
      .map((group) => ({
        ...group,
        hooks: (group.hooks || []).filter((h) => !String(h.command || '').includes(MARKER)),
      }))
      .filter((group) => (group.hooks || []).length > 0);
    if (after.length !== before.length) removed.push(event);
    if (after.length) settings.hooks[event] = after;
    else delete settings.hooks[event];
  }
  if (removed.length) writeJson(file, settings);
  return { removed };
}

export function hooksInstalled() {
  const settings = readJson(settingsFile(), null);
  if (!settings?.hooks) return [];
  return HOOK_EVENTS.filter((e) => hasOurHook(settings.hooks[e]));
}

/**
 * Installed hooks that can no longer run.
 *
 * The command pins the absolute path of the interpreter that installed it,
 * because a hook runs with a minimal environment and cannot count on `node`
 * being on PATH. The cost is that a version manager retiring that build leaves
 * a hook that silently does nothing, so `doctor` checks the path still exists.
 */
export function staleHooks() {
  const settings = readJson(settingsFile(), null);
  if (!settings?.hooks) return [];
  const stale = [];
  for (const event of HOOK_EVENTS) {
    for (const group of settings.hooks[event] || []) {
      for (const h of group.hooks || []) {
        const cmd = String(h.command || '');
        if (!cmd.includes(MARKER)) continue;
        const interpreter = cmd.match(/^"([^"]+)"/)?.[1];
        if (interpreter && !fs.existsSync(interpreter)) stale.push({ event, interpreter });
      }
    }
  }
  return stale;
}

const PERSIST_COMMAND = `---
description: Tag the current session so \`csm\` can find and resume it later
argument-hint: [tag] [more-tags...]
allowed-tools: Bash(csm:*)
---

Run this exact command, substituting the arguments the user gave:

\`\`\`bash
csm tag $ARGUMENTS
\`\`\`

Then report its output to the user in one short line. Do not do anything else.
If the command reports that no session could be identified, tell the user to run
\`csm doctor\`.
`;

export function installCommand() {
  const dest = path.join(commandsDir(), 'persist.md');
  fs.mkdirSync(commandsDir(), { recursive: true });
  fs.writeFileSync(dest, PERSIST_COMMAND);
  return dest;
}

export function uninstallCommand() {
  try {
    fs.unlinkSync(path.join(commandsDir(), 'persist.md'));
    return true;
  } catch {
    return false;
  }
}

export function commandInstalled() {
  return fs.existsSync(path.join(commandsDir(), 'persist.md'));
}

function stampFile(cwd) {
  const key = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return path.join(currentDir(), key + '.json');
}

/**
 * Record which session is live in this directory. Called by the hook on session
 * start and again on every prompt, so at the moment `/persist` runs the stamp
 * always names the session that submitted it.
 */
export function hookStamp(payload) {
  const cwd = payload.cwd || process.cwd();
  const sessionId = payload.session_id || payload.sessionId;
  if (!sessionId) return false;
  fs.mkdirSync(currentDir(), { recursive: true });
  writeJson(stampFile(cwd), {
    sessionId,
    cwd,
    transcript: payload.transcript_path || null,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Archive a tagged session as it ends.
 *
 * Tagging archives a snapshot, so without this every message sent after the
 * tag would be missing from the copy that outlives Claude Code's cleanup.
 * Untagged sessions are left alone — csm only keeps what you asked it to.
 */
export function hookEnd(payload) {
  const sessionId = payload.session_id || payload.sessionId;
  if (!sessionId || !tagsFor(sessionId).length) return false;

  let file = payload.transcript_path || null;
  if (!file || !fs.existsSync(file)) {
    const cwd = payload.cwd || process.cwd();
    const guess = path.join(projectsDir(), encodeProjectPath(cwd), sessionId + '.jsonl');
    file = fs.existsSync(guess) ? guess : null;
  }
  if (!file) return false;
  return archiveSession({ id: sessionId, file }).ok === true;
}

/**
 * Best guess at the session running in `cwd`: the hook stamp when it is fresh,
 * otherwise the most recently written transcript for that directory.
 */
export function resolveCurrentSession(cwd = process.cwd()) {
  const stamp = readJson(stampFile(cwd), null);
  if (stamp?.sessionId) {
    const age = Date.now() - new Date(stamp.updatedAt || 0).getTime();
    if (age < 12 * 3600 * 1000) return { id: stamp.sessionId, via: 'hook' };
  }
  const dir = path.join(projectsDir(), encodeProjectPath(cwd));
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const stat = fs.statSync(path.join(dir, f));
      if (!best || stat.mtimeMs > best.mtimeMs) best = { id: f.slice(0, -6), mtimeMs: stat.mtimeMs };
    }
  } catch {
    /* no transcripts for this directory */
  }
  if (best) return { id: best.id, via: 'mtime' };
  if (stamp?.sessionId) return { id: stamp.sessionId, via: 'stale-hook' };
  return null;
}
