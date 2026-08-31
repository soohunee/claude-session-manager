import { linksFile } from './paths.js';
import { readJson, writeJson } from './store.js';

const EMPTY = { version: 1, links: {} };

/**
 * Session lineage: which session a session was derived from.
 *
 * This lives apart from tags.json on purpose. `removeTags` deletes a session's
 * whole entry once its last tag is gone, so a `parent` field stored there would
 * vanish the moment someone untagged a session — taking the tree with it.
 *
 * Claude Code itself records nothing we could use instead: forking rewrites
 * every record in the copied transcript with the new session id, so a derived
 * session carries no trace of where it came from. The link only exists because
 * csm writes it down.
 */
export function loadLinks() {
  const data = readJson(linksFile(), null);
  if (!data || typeof data !== 'object' || !data.links) return { ...EMPTY, links: {} };
  return data;
}

export function saveLinks(data) {
  writeJson(linksFile(), data);
}

/** Record that `child` was derived from `parent`. Returns the stored entry. */
export function recordLink(child, parent, meta = {}) {
  if (!child || !parent || child === parent) return null;
  const store = loadLinks();
  const entry = {
    parent,
    createdAt: new Date().toISOString(),
    ...(meta.handoff ? { handoff: meta.handoff } : {}),
    ...(meta.cwd ? { cwd: meta.cwd } : {}),
    ...(meta.title ? { title: meta.title } : {}),
  };
  store.links[child] = entry;
  saveLinks(store);
  return entry;
}

export function removeLink(child) {
  const store = loadLinks();
  if (!store.links[child]) return false;
  delete store.links[child];
  saveLinks(store);
  return true;
}

export function parentOf(id, links = loadLinks().links) {
  return links[id]?.parent || null;
}

/**
 * Every session id that takes part in a lineage, as either end of a link.
 *
 * `prune` and `untag` use this to leave a tree's archives alone: dropping the
 * archive of a parent whose transcript Claude Code has already cleaned up would
 * strand its children under a root that no longer exists.
 */
export function linkedIds(links = loadLinks().links) {
  const ids = new Set();
  for (const [child, entry] of Object.entries(links)) {
    ids.add(child);
    if (entry.parent) ids.add(entry.parent);
  }
  return ids;
}

/**
 * Arrange sessions into parent/child order for display.
 *
 * Returns the same session objects in a flat list, each carrying the `depth` it
 * should be indented to. A child whose parent is not in `sessions` is promoted
 * to the top level rather than hidden: the parent may have been filtered out,
 * or its transcript may be gone entirely, and neither should make the child
 * disappear from a list it belongs in.
 */
export function buildTree(sessions, links = loadLinks().links) {
  const present = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map();
  const roots = [];
  for (const s of sessions) {
    const parent = links[s.id]?.parent;
    if (parent && present.has(parent) && parent !== s.id) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(s);
    } else {
      roots.push(s);
    }
  }

  const out = [];
  const seen = new Set();
  const walk = (s, depth) => {
    // A cycle can only come from a hand-edited links.json, but a stack overflow
    // is a poor way to report that.
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ ...s, depth });
    for (const kid of children.get(s.id) || []) walk(kid, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // Anything a cycle kept out still belongs in the list.
  for (const s of sessions) if (!seen.has(s.id)) out.push({ ...s, depth: 0 });
  return out;
}
