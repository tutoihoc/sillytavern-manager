'use strict';
/**
 * Knowledge about a SillyTavern installation on disk.
 *
 * Two layouts exist and the manager must handle both without shuffling the
 * user's files around:
 *
 *   "data"    SillyTavern >= 1.12 (2024-04). User data lives in
 *             <root>/data/<user-handle>/ - default handle "default-user".
 *             Multi-user capable.
 *   "public"  SillyTavern < 1.12. User data lives directly in <root>/public/
 *             (characters/, chats/, worlds/, ...). Single user.
 *
 * A backup produced by SillyTavern's own "Download Backup" button is a zip
 * whose ROOT IS THE CONTENTS of that user directory - characters/, chats/,
 * settings.json, secrets.json and friends sit at the top level, with no
 * wrapping folder. Verified against a real 2.36 GB export. We produce the same
 * shape, so our archives and SillyTavern's are interchangeable.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_USER = 'default-user';

/** Directories that are pure waste in an archive: rebuildable or duplicated. */
const ALWAYS_EXCLUDE = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /^thumbnails\//,      // regenerated from characters/ and backgrounds/
  /^vectors\//,         // regenerated embedding index
  /^backups\//,         // SillyTavern's own rolling chat copies; we are the backup
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
];

/**
 * Only conversational + configuration state. Excludes character cards, which
 * are usually the bulk (2.1 GB of the 2.36 GB sample) and are re-downloadable.
 */
const CHATS_ONLY = [
  'settings.json', 'stats.json',
  'chats/', 'group chats/', 'groups/',
  'worlds/', 'User Avatars/', 'user/',
  'QuickReplies/', 'themes/', 'movingUI/',
  'context/', 'instruct/', 'sysprompt/', 'reasoning/',
  'OpenAI Settings/', 'NovelAI Settings/', 'KoboldAI Settings/', 'TextGen Settings/',
];

/*
 * Profiles, sized against the 2.36 GB sample (uncompressed, after junk pruning):
 *
 *   full   3.23 GB / 4700 files
 *   chats  1.03 GB / 3016 files
 *
 * There is deliberately no "everything except extensions" tier: measured on
 * real data it saves ~20 MB, because the bulk of extensions/ is .git objects
 * that ALWAYS_EXCLUDE already drops. Character cards are the real weight
 * (2.16 GB of 3.23 GB), so the only meaningful choice is whether to carry them.
 */
const PROFILES = {
  full: {
    label: 'Everything',
    hint: 'Characters, chats, worlds, extensions and settings. Complete, and the largest.',
  },
  chats: {
    label: 'Chats and settings only',
    hint: 'Conversations, worlds and configuration. Skips character cards, which are usually most of the size and can be re-downloaded.',
  },
};

/** Build a filter(relPath) -> boolean for a profile. */
function makeFilter(profile, { includeSecrets = false } = {}) {
  return (rel) => {
    const p = rel.replace(/\\/g, '/');

    if (p === 'secrets.json') return !!includeSecrets;
    for (const re of ALWAYS_EXCLUDE) if (re.test(p)) return false;

    if (profile === 'chats') {
      return CHATS_ONLY.some((prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix));
    }
    return true;
  };
}

/** Which layout is this checkout using? */
function detectLayout(stRoot) {
  if (!stRoot || !fs.existsSync(stRoot)) return null;
  if (fs.existsSync(path.join(stRoot, 'data'))) return 'data';
  // Old builds keep user content inside public/ next to the front-end assets.
  if (fs.existsSync(path.join(stRoot, 'public', 'characters'))) return 'public';
  // A fresh checkout has neither yet; server.js decides on first run.
  if (fs.existsSync(path.join(stRoot, 'server.js'))) return 'data';
  return null;
}

/** Absolute path of the directory a backup zip's contents map onto. */
function userDataDir(stRoot, layout, handle = DEFAULT_USER) {
  if (layout === 'public') return path.join(stRoot, 'public');
  return path.join(stRoot, 'data', handle);
}

/** Handles present in a multi-user (data) install. */
async function listUsers(stRoot, layout) {
  if (layout !== 'data') return [DEFAULT_USER];
  try {
    const entries = await fsp.readdir(path.join(stRoot, 'data'), { withFileTypes: true });
    const users = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);
    return users.length ? users : [DEFAULT_USER];
  } catch {
    return [DEFAULT_USER];
  }
}

/** Installed version, read from the checkout's package.json. */
async function installedVersion(stRoot) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(stRoot, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function isInstalled(stRoot) {
  return fs.existsSync(path.join(stRoot, 'server.js'))
    && fs.existsSync(path.join(stRoot, 'node_modules'));
}

/**
 * Size of a directory under a given profile, so the UI can tell the user what a
 * backup will cost before they wait for it. Returns bytes and file count.
 */
async function measure(dir, filter) {
  let bytes = 0;
  let files = 0;
  async function walk(rel) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Cheap prune: if nothing under this prefix can pass, skip the subtree.
        if (!filter(`${r}/`) && !filter(`${r}/probe`)) continue;
        await walk(r);
      } else if (e.isFile() && filter(r)) {
        try {
          const st = await fsp.stat(path.join(dir, r));
          bytes += st.size;
          files++;
        } catch { /* vanished mid-scan */ }
      }
    }
  }
  await walk('');
  return { bytes, files };
}

/**
 * Does this zip look like a SillyTavern user-data backup?
 * We check for the markers that only appear at the root of such an export.
 */
function looksLikeUserBackup(entryNames) {
  const names = new Set(entryNames.map((n) => n.replace(/\\/g, '/')));
  const top = new Set([...names].map((n) => n.split('/')[0]));
  const markers = ['settings.json', 'characters', 'chats', 'worlds', 'User Avatars', 'secrets.json'];
  const hits = markers.filter((m) => top.has(m)).length;
  return { ok: hits >= 2, hits, topLevel: [...top].slice(0, 40) };
}

module.exports = {
  DEFAULT_USER,
  PROFILES,
  ALWAYS_EXCLUDE,
  makeFilter,
  detectLayout,
  userDataDir,
  listUsers,
  installedVersion,
  isInstalled,
  measure,
  looksLikeUserBackup,
};
