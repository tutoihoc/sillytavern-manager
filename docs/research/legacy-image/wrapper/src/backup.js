'use strict';
/**
 * Snapshot / restore of the SillyTavern data directory.
 *
 * Two tiers, because /mnt/workspace is durable but not safe:
 *   local  -> /mnt/workspace/_backups   survives restart & sleep, dies with the Studio
 *   remote -> Cloudflare R2 (optional)  survives Studio rename/transfer/deletion
 *
 * ModelScope explicitly warns that /mnt/workspace is lost on Studio transfer
 * or rename, so R2 is the only real disaster recovery. R2 free tier is 10 GB
 * with free egress, which is far more than a chat archive needs.
 */
const fsp = require('fs/promises');
const path = require('path').posix;
const { spawn } = require('child_process');
const { S3Client } = require('./s3');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0
      ? resolve(out)
      : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`)));
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

class Backup {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.running = false;
    this.last = null;
    this.timer = null;
    this.s3 = cfg.r2.enabled && cfg.r2.endpoint && cfg.r2.bucket
      ? new S3Client({
          endpoint: cfg.r2.endpoint,
          accessKeyId: cfg.r2.accessKeyId,
          secretAccessKey: cfg.r2.secretAccessKey,
          bucket: cfg.r2.bucket,
        })
      : null;
  }

  get remoteEnabled() { return !!this.s3; }

  /** tar.gz the data + config dirs into _backups, then optionally push to R2. */
  async create({ upload = true, label = '' } = {}) {
    if (this.running) throw new Error('a backup is already running');
    this.running = true;
    const name = `st_${stamp()}${label ? '_' + label.replace(/[^\w-]/g, '') : ''}.tar.gz`;
    const file = path.join(this.cfg.backupDir, name);
    try {
      await fsp.mkdir(this.cfg.backupDir, { recursive: true });
      // -C persistRoot so the archive holds relative "data/" and "config/".
      await run('tar', ['--force-local', '-czf', file, '-C', this.cfg.persistRoot, 'data', 'config']);
      const st = await fsp.stat(file);
      const result = { name, file, bytes: st.size, at: new Date().toISOString(), remote: false };

      if (upload && this.s3) {
        const buf = await fsp.readFile(file);
        await this.s3.put(`${this.cfg.r2.prefix}/${name}`, buf, 'application/gzip');
        result.remote = true;
        this.log.info(`backup ${name} (${(st.size / 1e6).toFixed(1)} MB) uploaded to R2`);
      } else {
        this.log.info(`backup ${name} (${(st.size / 1e6).toFixed(1)} MB) written locally`);
      }

      this.last = result;
      await this.prune();
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Keep only the newest `keep` archives, locally and remotely. */
  async prune() {
    const keep = Math.max(1, this.cfg.r2.keep);
    try {
      const local = (await fsp.readdir(this.cfg.backupDir))
        .filter((f) => f.endsWith('.tar.gz')).sort();
      for (const f of local.slice(0, Math.max(0, local.length - keep))) {
        await fsp.unlink(path.join(this.cfg.backupDir, f)).catch(() => {});
      }
    } catch { /* nothing to prune */ }

    if (!this.s3) return;
    try {
      const remote = (await this.s3.list(this.cfg.r2.prefix + '/'))
        .filter((o) => o.key.endsWith('.tar.gz'))
        .sort((a, b) => a.key.localeCompare(b.key));
      for (const o of remote.slice(0, Math.max(0, remote.length - keep))) {
        await this.s3.delete(o.key).catch(() => {});
      }
    } catch (err) {
      this.log.warn(`remote prune failed: ${err.message}`);
    }
  }

  async listLocal() {
    try {
      const files = (await fsp.readdir(this.cfg.backupDir)).filter((f) => f.endsWith('.tar.gz'));
      const out = [];
      for (const f of files) {
        const st = await fsp.stat(path.join(this.cfg.backupDir, f));
        out.push({ name: f, bytes: st.size, at: st.mtime.toISOString(), where: 'local' });
      }
      return out.sort((a, b) => b.name.localeCompare(a.name));
    } catch { return []; }
  }

  async listRemote() {
    if (!this.s3) return [];
    try {
      return (await this.s3.list(this.cfg.r2.prefix + '/'))
        .filter((o) => o.key.endsWith('.tar.gz'))
        .map((o) => ({ name: path.basename(o.key), key: o.key, bytes: o.size, at: o.modified, where: 'r2' }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch (err) {
      this.log.warn(`remote list failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Restore an archive over the live data dir.
   * Always snapshots the current state first - a restore that eats the only
   * good copy is worse than no restore at all.
   */
  async restore(name, { from = 'local' } = {}) {
    if (!/^[\w.-]+\.tar\.gz$/.test(name)) throw new Error('invalid backup name');
    const safety = await this.create({ upload: false, label: 'prerestore' });

    let file = path.join(this.cfg.backupDir, name);
    if (from === 'r2') {
      if (!this.s3) throw new Error('R2 is not configured');
      const buf = await this.s3.get(`${this.cfg.r2.prefix}/${name}`);
      file = path.join(this.cfg.backupDir, name);
      await fsp.writeFile(file, buf);
    }
    await fsp.access(file);
    await run('tar', ['--force-local', '-xzf', file, '-C', this.cfg.persistRoot]);
    this.log.info(`restored ${name} (safety copy: ${safety.name})`);
    return { restored: name, safety: safety.name, restartRequired: true };
  }

  /** Import a user-uploaded archive buffer, then restore it. */
  async importArchive(buffer, filename = 'upload.tar.gz') {
    const name = `st_${stamp()}_imported.tar.gz`;
    const file = path.join(this.cfg.backupDir, name);
    await fsp.mkdir(this.cfg.backupDir, { recursive: true });
    await fsp.writeFile(file, buffer);
    try {
      await run('tar', ['--force-local', '-tzf', file]); // reject anything that is not a real tarball
    } catch {
      await fsp.unlink(file).catch(() => {});
      throw new Error(`${filename} is not a valid .tar.gz archive`);
    }
    return this.restore(name, { from: 'local' });
  }

  startSchedule() {
    const mins = this.cfg.r2.intervalMin;
    if (!this.s3 || mins <= 0) return;
    this.timer = setInterval(() => {
      this.create({ upload: true, label: 'auto' })
        .catch((err) => this.log.warn(`scheduled backup failed: ${err.message}`));
    }, mins * 60_000);
    if (this.timer.unref) this.timer.unref();
    this.log.info(`automatic R2 backup every ${mins} min`);
  }

  stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { Backup };
