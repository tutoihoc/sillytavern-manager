'use strict';
/**
 * Backup and restore of the SillyTavern user-data directory.
 *
 * Archives are byte-compatible with SillyTavern's own "Download Backup": the
 * zip root is the contents of the user directory, so a file exported from
 * SillyTavern can be restored here, and a file exported here can be handed
 * back to SillyTavern. Verified against a real 2.36 GB export.
 *
 * Scheduling notes, because the honest answer is "it depends on the host":
 *
 *   - A full backup of a heavy install is gigabytes. Uploading that every hour
 *     is pointless when nothing changed, so every run first compares a cheap
 *     signature (file count, total size, newest mtime) and skips if identical.
 *   - ModelScope Studios sleep with little warning. We back up on an interval
 *     AND on SIGTERM, but a multi-gigabyte upload cannot finish inside a
 *     shutdown grace period, so the shutdown pass is deliberately the small
 *     "chats" profile with a hard timeout.
 *   - Cloudflare R2's free tier is 10 GB. Keeping 3 copies of a 2.4 GB archive
 *     already uses 7.2 GB, so retention defaults are small and the UI shows
 *     measured sizes before the user commits.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ST = require('./sillytavern');
const { createZipFromDir, extractZip, listZip } = require('./archive');
const { S3Client } = require('./s3');

const NAME_RE = /^stm-(full|chats)-(\d{8}-\d{6})(?:-([a-z]+))?\.zip$/;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class BackupManager {
  constructor({ paths, store, logs, getDataDir }) {
    this.paths = paths;
    this.store = store;
    this.logs = logs;
    this.log = logs.logger('backup');
    this.getDataDir = getDataDir;      // () => absolute user-data dir, or null

    this.running = null;               // { kind, startedAt, progress }
    this.last = null;
    this.timer = null;
  }

  // ---- remote ------------------------------------------------------------

  remoteConfig() {
    return this.store.get('backup.remote', {});
  }

  client() {
    const r = this.remoteConfig();
    if (!r.enabled || !r.endpoint || !r.bucket || !r.accessKeyId || !r.secretAccessKey) return null;
    return new S3Client({
      endpoint: r.endpoint,
      bucket: r.bucket,
      region: r.region || 'auto',
      accessKeyId: r.accessKeyId,
      secretAccessKey: r.secretAccessKey,
    });
  }

  // ---- change detection --------------------------------------------------

  /**
   * Cheap fingerprint of what a backup would contain. Comparing this against
   * the previous run avoids re-uploading gigabytes when nothing has changed.
   */
  async signature(profile) {
    const dir = this.getDataDir();
    if (!dir) return null;
    const filter = ST.makeFilter(profile, { includeSecrets: this.store.get('backup.includeSecrets', false) });
    let files = 0;
    let bytes = 0;
    let newest = 0;
    const walk = async (rel) => {
      let entries;
      try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!filter(`${r}/`) && !filter(`${r}/probe`)) continue;
          await walk(r);
        } else if (e.isFile() && filter(r)) {
          try {
            const st = await fsp.stat(path.join(dir, r));
            files++; bytes += st.size;
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          } catch { /* raced */ }
        }
      }
    };
    await walk('');
    return { files, bytes, newest };
  }

  sameAsLast(sig) {
    const prev = this.store.get('backup.lastSignature');
    return !!(prev && sig && prev.files === sig.files && prev.bytes === sig.bytes && prev.newest === sig.newest);
  }

  /** Sizes per profile, for the UI to show before the user picks one. */
  async estimate() {
    const dir = this.getDataDir();
    if (!dir) return null;
    const includeSecrets = this.store.get('backup.includeSecrets', false);
    const out = {};
    for (const profile of Object.keys(ST.PROFILES)) {
      out[profile] = await ST.measure(dir, ST.makeFilter(profile, { includeSecrets }));
    }
    return out;
  }

  // ---- creating ----------------------------------------------------------

  /**
   * Make a backup.
   * @param profile "full" | "chats"
   * @param opts.upload  push to S3/R2 when configured
   * @param opts.label   suffix, e.g. "auto" | "manual" | "prerestore" | "shutdown"
   * @param opts.force   ignore the unchanged-since-last check
   */
  async create({ profile = null, upload = true, label = 'manual', force = false } = {}) {
    if (this.running) throw new Error('a backup is already running');

    const dir = this.getDataDir();
    if (!dir) throw new Error('SillyTavern is not installed yet, so there is nothing to back up');

    profile = profile || this.store.get('backup.profile', 'full');
    if (!ST.PROFILES[profile]) throw new Error(`unknown backup profile "${profile}"`);

    const sig = await this.signature(profile);
    if (!force && label === 'auto' && this.sameAsLast(sig)) {
      this.log.info('Nothing changed since the last backup; skipping');
      return { skipped: true, reason: 'unchanged' };
    }

    const includeSecrets = this.store.get('backup.includeSecrets', false);
    const name = `stm-${profile}-${stamp()}${label && label !== 'manual' ? `-${label}` : ''}.zip`;
    const file = path.join(this.paths.backupDir, name);

    this.running = { kind: 'backup', name, profile, startedAt: Date.now(), progress: { phase: 'archiving' } };
    this.log.info(`Creating ${profile} backup -> ${name}`);

    try {
      await fsp.mkdir(this.paths.backupDir, { recursive: true });
      const filter = ST.makeFilter(profile, { includeSecrets });

      const res = await createZipFromDir(dir, file, {
        filter,
        onProgress: ({ added, bytes }) => {
          this.running.progress = { phase: 'archiving', files: added, bytes };
        },
      });

      const record = {
        name,
        profile,
        includeSecrets,
        bytes: res.size,
        rawBytes: res.rawBytes,
        files: res.files,
        at: new Date().toISOString(),
        remote: false,
      };

      const s3 = upload ? this.client() : null;
      if (s3) {
        this.running.progress = { phase: 'uploading', sent: 0, total: res.size };
        const key = `${this.remoteConfig().prefix || 'sillytavern'}/${name}`;
        this.log.info(`Uploading ${(res.size / 1e6).toFixed(1)} MB to ${this.remoteConfig().bucket}/${key}`);
        await s3.uploadFile(key, file, {
          onProgress: ({ sent, total, part, parts }) => {
            this.running.progress = { phase: 'uploading', sent, total, part, parts };
          },
        });
        record.remote = true;
        record.key = key;
        this.log.info('Upload complete');
      }

      this.store.set('backup.lastSignature', sig);
      this.store.set('backup.last', record);
      this.last = record;
      await this.prune();
      this.log.info(`Backup finished: ${name} (${(res.size / 1e6).toFixed(1)} MB, ${res.files} files)`);
      return record;
    } catch (err) {
      await fsp.rm(file, { force: true }).catch(() => {});
      this.log.error(`Backup failed: ${err.message}`);
      throw err;
    } finally {
      this.running = null;
    }
  }

  // ---- listing / retention -----------------------------------------------

  async listLocal() {
    try {
      const files = (await fsp.readdir(this.paths.backupDir)).filter((f) => f.endsWith('.zip'));
      const out = [];
      for (const name of files) {
        try {
          const st = await fsp.stat(path.join(this.paths.backupDir, name));
          const m = NAME_RE.exec(name);
          out.push({
            name,
            bytes: st.size,
            at: st.mtime.toISOString(),
            where: 'local',
            profile: m ? m[1] : 'unknown',
            label: m && m[3] ? m[3] : null,
            foreign: !m,           // e.g. a file exported by SillyTavern itself
          });
        } catch { /* raced */ }
      }
      return out.sort((a, b) => (a.at < b.at ? 1 : -1));
    } catch {
      return [];
    }
  }

  async listRemote() {
    const s3 = this.client();
    if (!s3) return [];
    try {
      const prefix = `${this.remoteConfig().prefix || 'sillytavern'}/`;
      return (await s3.list(prefix))
        .filter((o) => o.key.endsWith('.zip'))
        .map((o) => {
          const name = o.key.slice(o.key.lastIndexOf('/') + 1);
          const m = NAME_RE.exec(name);
          return {
            name, key: o.key, bytes: o.size, at: o.modified, where: 'remote',
            profile: m ? m[1] : 'unknown', label: m && m[3] ? m[3] : null,
          };
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1));
    } catch (err) {
      this.log.warn(`Could not list remote backups: ${err.message}`);
      return [];
    }
  }

  async prune() {
    const keepLocal = Math.max(1, this.store.get('backup.keepLocal', 5));
    const local = (await this.listLocal()).filter((b) => !b.foreign);
    for (const b of local.slice(keepLocal)) {
      await fsp.rm(path.join(this.paths.backupDir, b.name), { force: true }).catch(() => {});
      this.log.info(`Pruned local backup ${b.name}`);
    }

    const s3 = this.client();
    if (!s3) return;
    const keepRemote = Math.max(1, this.remoteConfig().keepRemote || 3);
    const remote = await this.listRemote();
    for (const b of remote.slice(keepRemote)) {
      await s3.delete(b.key).catch(() => {});
      this.log.info(`Pruned remote backup ${b.name}`);
    }
  }

  // ---- restoring ---------------------------------------------------------

  /**
   * Inspect an archive before doing anything destructive with it, so the UI can
   * show the user what they are about to restore.
   */
  async inspect(zipPath) {
    const entries = await listZip(zipPath);
    const names = entries.map((e) => e.name);
    const verdict = ST.looksLikeUserBackup(names);
    const bytes = entries.reduce((n, e) => n + e.size, 0);
    return {
      entries: entries.length,
      rawBytes: bytes,
      recognised: verdict.ok,
      markerHits: verdict.hits,
      topLevel: verdict.topLevel,
      hasSecrets: names.includes('secrets.json'),
    };
  }

  /**
   * Restore an archive over the live user-data directory.
   * A safety copy is always taken first - a restore that destroys the only good
   * copy is worse than no restore at all.
   */
  async restore(zipPath, { wipe = false } = {}) {
    if (this.running) throw new Error('a backup or restore is already running');
    const dir = this.getDataDir();
    if (!dir) throw new Error('SillyTavern is not installed yet');

    const info = await this.inspect(zipPath);
    if (!info.recognised) {
      throw new Error(
        'This zip does not look like SillyTavern user data. Expected folders such as '
        + 'characters/, chats/ or settings.json at the top level; found: '
        + info.topLevel.slice(0, 6).join(', '),
      );
    }

    this.running = { kind: 'restore', startedAt: Date.now(), progress: { phase: 'safety-copy' } };
    try {
      let safety = null;
      try {
        this.running = null;                      // create() guards on this
        safety = await this.create({ profile: 'full', upload: false, label: 'prerestore', force: true });
      } finally {
        this.running = { kind: 'restore', startedAt: Date.now(), progress: { phase: 'extracting' } };
      }

      if (wipe) {
        this.log.warn('Removing existing user data before restore (wipe requested)');
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          await fsp.rm(path.join(dir, e.name), { recursive: true, force: true }).catch(() => {});
        }
      }

      this.log.info(`Restoring ${info.entries} entries into ${dir}`);
      const res = await extractZip(zipPath, dir, {
        onProgress: ({ done, total, bytes }) => {
          this.running.progress = { phase: 'extracting', done, total, bytes };
        },
      });

      this.store.set('backup.lastSignature', null);   // force the next auto run
      this.log.info(`Restore complete: ${res.written} files written`);
      return { restored: res.written, skipped: res.skipped, safety: safety ? safety.name : null, restartRequired: true };
    } catch (err) {
      this.log.error(`Restore failed: ${err.message}`);
      throw err;
    } finally {
      this.running = null;
    }
  }

  /** Pull a remote archive down to the local backup directory. */
  async fetchRemote(name) {
    const s3 = this.client();
    if (!s3) throw new Error('remote storage is not configured');
    if (!/^[\w.-]+\.zip$/.test(name)) throw new Error('invalid backup name');
    const key = `${this.remoteConfig().prefix || 'sillytavern'}/${name}`;
    const dest = path.join(this.paths.backupDir, name);
    await fsp.mkdir(this.paths.backupDir, { recursive: true });
    this.log.info(`Downloading ${key} from remote storage`);
    await s3.getToFile(key, dest, ({ received, total }) => {
      this.running = { kind: 'download', progress: { phase: 'downloading', received, total } };
    });
    this.running = null;
    return { name, path: dest };
  }

  pathFor(name) {
    if (!/^[\w.@+-]+\.zip$/.test(name)) throw new Error('invalid backup name');
    return path.join(this.paths.backupDir, name);
  }

  // ---- scheduling --------------------------------------------------------

  startSchedule() {
    this.stopSchedule();
    const minutes = Number(this.store.get('backup.intervalMinutes', 60));
    if (!minutes || minutes <= 0) {
      this.log.info('Automatic backups are off');
      return;
    }
    this.timer = setInterval(() => {
      this.create({ upload: true, label: 'auto' })
        .catch((err) => this.log.warn(`Scheduled backup failed: ${err.message}`));
    }, minutes * 60_000);
    this.timer.unref?.();
    this.log.info(`Automatic backup every ${minutes} minutes (skipped when nothing changed)`);
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Last-gasp backup when the process is being shut down. Deliberately the
   * small profile with a timeout: a multi-gigabyte archive cannot finish inside
   * a shutdown grace period, and a half-written one helps nobody.
   */
  async onShutdown({ timeoutMs = 20_000 } = {}) {
    if (!this.store.get('backup.onShutdown', true)) return { skipped: true };
    if (!this.getDataDir()) return { skipped: true };
    this.log.info('Shutting down - taking a quick chats backup');
    try {
      return await Promise.race([
        this.create({ profile: 'chats', upload: false, label: 'shutdown', force: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
      ]);
    } catch (err) {
      this.log.warn(`Shutdown backup did not finish: ${err.message}`);
      return { failed: err.message };
    }
  }

  status() {
    return {
      running: this.running,
      last: this.store.get('backup.last', null),
      remoteEnabled: !!this.client(),
      profile: this.store.get('backup.profile', 'full'),
      intervalMinutes: this.store.get('backup.intervalMinutes', 60),
      keepLocal: this.store.get('backup.keepLocal', 5),
    };
  }
}

module.exports = { BackupManager, NAME_RE, stamp };
