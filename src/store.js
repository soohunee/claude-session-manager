import fs from 'node:fs';
import path from 'node:path';
import { csmHome, tagsFile } from './paths.js';

const EMPTY = { version: 1, sessions: {} };

export function ensureHome() {
  fs.mkdirSync(csmHome(), { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write atomically so a crash mid-write can never truncate the tag store. */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadTags() {
  const data = readJson(tagsFile(), null);
  if (!data || typeof data !== 'object' || !data.sessions) return { ...EMPTY, sessions: {} };
  return data;
}

export function saveTags(data) {
  writeJson(tagsFile(), data);
}

export function normalizeTag(tag) {
  return String(tag).trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
}

/** Add tags to a session, returning the tags that were newly added. */
export function addTags(sessionId, tags, meta = {}) {
  const store = loadTags();
  const entry = store.sessions[sessionId] || { tags: [], taggedAt: new Date().toISOString() };
  const before = new Set(entry.tags);
  for (const t of tags.map(normalizeTag).filter(Boolean)) before.add(t);
  entry.tags = [...before].sort();
  entry.updatedAt = new Date().toISOString();
  if (meta.cwd) entry.cwd = meta.cwd;
  if (meta.title) entry.title = meta.title;
  store.sessions[sessionId] = entry;
  saveTags(store);
  return entry;
}

export function removeTags(sessionId, tags) {
  const store = loadTags();
  const entry = store.sessions[sessionId];
  if (!entry) return null;
  if (!tags || tags.length === 0) {
    delete store.sessions[sessionId];
    saveTags(store);
    return { tags: [] };
  }
  const drop = new Set(tags.map(normalizeTag));
  entry.tags = entry.tags.filter((t) => !drop.has(t));
  if (entry.tags.length === 0) delete store.sessions[sessionId];
  else store.sessions[sessionId] = entry;
  saveTags(store);
  return entry;
}

export function tagsFor(sessionId) {
  return loadTags().sessions[sessionId]?.tags || [];
}
