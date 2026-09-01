import fs from 'node:fs';
import path from 'node:path';
import { projectsDir, historyFile, archiveDir, indexFile } from './paths.js';
import { readJson, writeJson, loadTags } from './store.js';
import { loadLinks } from './links.js';

const INDEX_VERSION = 3;

/** Pull readable text out of a message record's `content` (string or block array). */
export function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
}

/**
 * Extract session metadata from one transcript.
 *
 * Transcripts run to hundreds of KB, so we avoid JSON.parse on every line:
 * a cheap substring guard decides whether a line is worth parsing at all.
 */
export function parseTranscript(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const meta = {
    title: null,
    cwd: null,
    gitBranch: null,
    version: null,
    firstPrompt: null,
    lastPrompt: null,
    messages: 0,
    firstSeen: null,
    lastSeen: null,
    contextTokens: null,
    model: null,
  };

  for (const line of raw.split('\n')) {
    if (line.length < 2) continue;

    if (line.includes('"ai-title"')) {
      const d = tryParse(line);
      if (d?.aiTitle) meta.title = d.aiTitle;
      continue;
    }

    const isUser = line.includes('"type":"user"');
    const isAssistant = !isUser && line.includes('"type":"assistant"');
    const needsCwd = !meta.cwd && line.includes('"cwd"');
    const hasTs = line.includes('"timestamp"');
    if (!isUser && !isAssistant && !needsCwd && !hasTs) continue;

    const d = tryParse(line);
    if (!d) continue;

    if (!meta.cwd && d.cwd) {
      meta.cwd = d.cwd;
      if (d.gitBranch) meta.gitBranch = d.gitBranch;
      if (d.version) meta.version = d.version;
    }
    if (d.timestamp) {
      if (!meta.firstSeen) meta.firstSeen = d.timestamp;
      meta.lastSeen = d.timestamp;
    }
    if (isAssistant && !d.isSidechain) {
      // What the model was actually sent on its last turn: the whole prompt,
      // cache hits included. That is the context in use at the point the
      // session was left, so it drops back down after a compaction, which is
      // the honest thing for it to do.
      const u = d.message?.usage;
      if (u && typeof u === 'object') {
        const total =
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (total > 0) {
          meta.contextTokens = total;
          if (d.message.model) meta.model = d.message.model;
        }
      }
    }
    if ((isUser || isAssistant) && !d.isSidechain) {
      meta.messages++;
      if (isUser && !d.isMeta) {
        const text = textOf(d.message).trim();
        // Skip tool results and the local-command envelopes Claude Code injects.
        if (text && !text.startsWith('<')) {
          if (!meta.firstPrompt) meta.firstPrompt = text.slice(0, 300);
          meta.lastPrompt = text.slice(0, 300);
        }
      }
    }
  }
  return meta;
}

function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function listTranscripts() {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of projects) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(projectsDir(), dirent.name);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push({ id: f.slice(0, -6), file: path.join(dir, f), source: 'live' });
    }
  }
  return out;
}

function listArchived() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(archiveDir());
  } catch {
    return out;
  }
  for (const f of files) {
    if (f.endsWith('.jsonl')) out.push({ id: f.slice(0, -6), file: path.join(archiveDir(), f), source: 'archive' });
  }
  return out;
}

/**
 * Claude Code appends every prompt here regardless of directory, so it is the
 * one place that remembers sessions whose transcript has already been cleaned up.
 */
export function readHistory() {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(historyFile(), 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    if (line.length < 2) continue;
    const d = tryParse(line);
    if (!d?.sessionId) continue;
    const prev = map.get(d.sessionId);
    if (!prev || (d.timestamp || 0) > prev.lastTs) {
      map.set(d.sessionId, {
        cwd: d.project || prev?.cwd || null,
        lastTs: d.timestamp || prev?.lastTs || 0,
        lastPrompt: d.display || prev?.lastPrompt || null,
        prompts: (prev?.prompts || 0) + 1,
        firstPrompt: prev?.firstPrompt || d.display || null,
      });
    } else {
      prev.prompts++;
    }
  }
  return map;
}

/** Build the full session list, reusing cached metadata for unchanged files. */
export function scanSessions({ refresh = false } = {}) {
  const cache = refresh ? {} : readJson(indexFile(), {})?.version === INDEX_VERSION
    ? readJson(indexFile(), {}).entries || {}
    : {};
  const nextCache = {};
  const byId = new Map();

  for (const item of [...listArchived(), ...listTranscripts()]) {
    let stat;
    try {
      stat = fs.statSync(item.file);
    } catch {
      continue;
    }
    const key = item.file;
    const cached = cache[key];
    const meta =
      cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        ? cached.meta
        : parseTranscript(item.file);
    if (!meta) continue;
    nextCache[key] = { mtimeMs: stat.mtimeMs, size: stat.size, meta };

    const existing = byId.get(item.id);
    // A live transcript always wins over its archived copy; the archive only
    // fills in for sessions Claude Code has already deleted.
    if (existing && item.source === 'archive') {
      existing.archived = true;
      continue;
    }
    byId.set(item.id, {
      id: item.id,
      file: item.file,
      source: item.source,
      archived: item.source === 'archive' || existing?.archived || false,
      resumable: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ...meta,
      updatedAt: meta.lastSeen || new Date(stat.mtimeMs).toISOString(),
    });
  }

  const history = readHistory();
  for (const [id, h] of history) {
    const existing = byId.get(id);
    if (existing) {
      if (!existing.cwd) existing.cwd = h.cwd;
      if (!existing.lastPrompt) existing.lastPrompt = h.lastPrompt;
      continue;
    }
    // Transcript is gone — Claude Code cleaned it up. Listed, but not resumable.
    byId.set(id, {
      id,
      file: null,
      source: 'history',
      archived: false,
      resumable: false,
      sizeBytes: 0,
      mtimeMs: h.lastTs,
      title: null,
      cwd: h.cwd,
      gitBranch: null,
      version: null,
      firstPrompt: h.firstPrompt,
      lastPrompt: h.lastPrompt,
      messages: h.prompts,
      firstSeen: null,
      lastSeen: h.lastTs ? new Date(h.lastTs).toISOString() : null,
      updatedAt: h.lastTs ? new Date(h.lastTs).toISOString() : null,
    });
  }

  const tags = loadTags().sessions;
  const links = loadLinks().links;
  const sessions = [...byId.values()].map((s) => {
    const link = links[s.id];
    return {
      ...s,
      tags: tags[s.id]?.tags || [],
      parent: link?.parent || null,
      // A derived session opens with the handoff instructions csm wrote, so
      // falling through to `firstPrompt` would label every one of them with the
      // same boilerplate. Naming its parent is the useful answer until Claude
      // Code gets around to titling it.
      label:
        s.title ||
        (link ? `\u2191 ${link.title || 'derived session'}` : null) ||
        s.firstPrompt ||
        s.lastPrompt ||
        '(untitled)',
    };
  });

  sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  try {
    writeJson(indexFile(), { version: INDEX_VERSION, entries: nextCache });
  } catch {
    // A read-only cache is a performance problem, not a correctness one.
  }
  return sessions;
}

/**
 * Sessions Claude Code never gave a name to.
 *
 * It writes an `ai-title` record once a session has an actual conversation in
 * it, so the ones without a title are what running a slash command leaves
 * behind: `/plugins`, `/login`, a stray `1`. On this machine every unnamed
 * session had a median of 2 messages and every named one a median of 198, with
 * no named session under 7 — so this is Claude Code's own judgement rather than
 * a threshold csm invented.
 *
 * The grace period matters: a session started a minute ago has not been named
 * *yet*, which is a different thing from never being named, and hiding the
 * conversation someone just closed would be the worst possible miss.
 */
export function isUnnamed(session, now = Date.now()) {
  if (!session || session.title) return false;
  // A derived session carries csm's own label, `↑ <what it came from>`, and a
  // recorded parent. Claude Code will not have titled it yet, but it is the
  // opposite of a leftover: someone deliberately started it to continue work.
  if (session.parent) return false;
  const age = now - new Date(session.updatedAt || 0).getTime();
  return !(age < 60 * 60 * 1000);
}

export const SORT_MODES = ['time', 'title', 'dir'];

/**
 * Reorder an already-scanned list. Sessions with no recorded directory sort
 * last under `dir` rather than colliding under an empty key, and every mode
 * falls back to recency so the order is total and stable.
 */
export function sortSessions(sessions, mode = 'time') {
  const byTime = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  const list = [...sessions];
  if (mode === 'title') {
    return list.sort((a, b) => (a.label || '').localeCompare(b.label || '') || byTime(a, b));
  }
  if (mode === 'dir') {
    return list.sort(
      (a, b) =>
        Number(!a.cwd) - Number(!b.cwd) ||
        (a.cwd || '').localeCompare(b.cwd || '') ||
        byTime(a, b)
    );
  }
  return list.sort(byTime);
}
