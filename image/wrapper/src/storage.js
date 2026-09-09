'use strict';
/**
 * Persistence against the ModelScope Studio persistent volume.
 *
 * Facts this is built around (from ModelScope's Docker Studio docs):
 *   - Anything written outside /mnt/workspace is LOST on every restart.
 *   - /mnt/workspace IS retained across restarts and sleep/wake.
 *   - /mnt/workspace is NOT mounted during `docker build`, so defaults have to
 *     be baked in elsewhere and copied across on first boot.
 *   - It is still lost if the Studio is renamed or transferred to another
 *     owner - which is why the R2 backup in backup.js is not optional garnish.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path').posix;

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function isEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Copy `src` into `dest` without clobbering anything the user already has.
 * Used to lay image defaults down onto a fresh volume.
 */
async function copyMissing(src, dest) {
  if (!await exists(src)) return 0;
  await ensureDir(dest);
  let copied = 0;
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += await copyMissing(s, d);
    } else if (!await exists(d)) {
      await fsp.copyFile(s, d);
      copied++;
    }
  }
  return copied;
}

/**
 * Verify the persistent volume is real. If /mnt/workspace is missing we are
 * probably not on ModelScope (local test, or the mount failed) - the caller
 * must know, because silently writing to a doomed directory is how people
 * lose their chats.
 */
async function checkPersistence(cfg, log) {
  const mountRoot = '/mnt/workspace';
  const mounted = await exists(mountRoot);
  if (!mounted) {
    log.warn(`${mountRoot} does not exist - data will NOT survive a restart.`);
    log.warn('If you are on ModelScope, this is a bug; report it. Locally, this is expected.');
    return { persistent: false, root: cfg.persistRoot };
  }
  // Prove it is writable, not just present.
  const probe = path.join(cfg.persistRoot, '.write-probe');
  try {
    await ensureDir(cfg.persistRoot);
    await fsp.writeFile(probe, String(Date.now()));
    await fsp.unlink(probe);
  } catch (err) {
    log.error(`${cfg.persistRoot} is not writable: ${err.message}`);
    return { persistent: false, root: cfg.persistRoot, error: err.message };
  }
  return { persistent: true, root: cfg.persistRoot };
}

/** Create the directory layout and seed first-boot defaults. */
async function initLayout(cfg, log) {
  for (const d of [cfg.dataDir, cfg.configDir, cfg.pluginsDir,
                   cfg.extensionsDir, cfg.stateDir, cfg.backupDir]) {
    await ensureDir(d);
  }

  const freshConfig = await isEmpty(cfg.configDir);
  const seededConfig = await copyMissing(path.join(cfg.seedDir, 'config'), cfg.configDir);
  const seededData = await copyMissing(path.join(cfg.seedDir, 'data'), cfg.dataDir);

  if (freshConfig) log.info(`first boot: seeded ${seededConfig} config file(s)`);
  if (seededData) log.info(`seeded ${seededData} data file(s)`);

  return { freshConfig, seededConfig, seededData };
}

/** Tiny JSON-file key/value store for wrapper state (install id, consent, ...). */
class State {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* first boot */ }
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    this.data[k] = v;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* volume gone; keep running in memory */ }
    return v;
  }
  all() { return { ...this.data }; }
}

/** Recursive size of a directory, for the storage widget in the UI. */
async function dirSize(dir) {
  let total = 0;
  let files = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { const st = await fsp.stat(p); total += st.size; files++; } catch { /* raced */ }
      }
    }
  }
  await walk(dir);
  return { bytes: total, files };
}

module.exports = { ensureDir, isEmpty, exists, copyMissing, checkPersistence, initLayout, State, dirSize };
