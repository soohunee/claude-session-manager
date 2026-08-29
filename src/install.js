import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { settingsFile, commandsDir, currentDir, projectsDir, encodeProjectPath } from './paths.js';
import { readJson, writeJson } from './store.js';

const MARKER = 'csm-hook-stamp';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'];

function binPath() {
  return path.resolve(fileURLToPath(new URL('../bin/csm.js', import.meta.url)));
}

function hookCommand() {
  // Quoted so a space in the install path can't split the command, and
  // `|| true` so a csm failure can never block the user's prompt.
  return `"${process.execPath}" "${binPath()}" hook-stamp # ${MARKER}\n`.trim() + ' || true';
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
  for (const event of HOOK_EVENTS) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (hasOurHook(settings.hooks[event])) continue;
    settings.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command: hookCommand() }],
    });
    added.push(event);
  }
  if (added.length) writeJson(file, settings);
  return { added, backup: fs.existsSync(file + '.csm-backup') ? file + '.csm-backup' : null };
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
