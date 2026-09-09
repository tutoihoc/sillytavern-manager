'use strict';
/**
 * REST API for the control panel, mounted under /manager/api.
 *
 * Two rules shape this file:
 *   - Uploads and downloads are streamed. A real backup is gigabytes; buffering
 *     one would kill the process on a phone or a 2 vCPU Studio.
 *   - Long jobs (install, backup, restore) return immediately and expose
 *     progress through a job record the UI polls. No request is held open for
 *     minutes, because a Cloudflare quick tunnel will not keep it alive.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const installer = require('./core/installer');
const { TERMS } = require('./core/telemetry');
const { PROFILES } = require('./core/sillytavern');
const { S3Client } = require('./core/s3');

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

function readJson(req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Stream a request body straight to disk - used for multi-GB restore uploads. */
function streamToFile(req, destFile, onProgress) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destFile);
    let received = 0;
    const total = Number(req.headers['content-length']) || 0;
    req.on('data', (c) => {
      received += c.length;
      if (onProgress) onProgress({ received, total });
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve({ bytes: received }));
    req.pipe(out);
  });
}

/** Simple in-memory job registry so the UI can follow long operations. */
class Jobs {
  constructor() { this.map = new Map(); }

  start(kind, meta = {}) {
    const id = crypto.randomUUID();
    this.map.set(id, {
      id, kind, ...meta,
      state: 'running', percent: 0, phase: 'starting',
      startedAt: Date.now(), log: [],
    });
    // Keep the registry small.
    if (this.map.size > 20) {
      const oldest = [...this.map.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      this.map.delete(oldest.id);
    }
    return this.map.get(id);
  }

  update(id, patch) {
    const job = this.map.get(id);
    if (!job) return;
    Object.assign(job, patch);
    if (patch.phase && job.log[job.log.length - 1] !== patch.phase) job.log.push(patch.phase);
  }

  finish(id, patch = {}) { this.update(id, { state: 'done', percent: 100, finishedAt: Date.now(), ...patch }); }
  fail(id, error) { this.update(id, { state: 'failed', error: String(error && error.message || error), finishedAt: Date.now() }); }
  get(id) { return this.map.get(id) || null; }
  all() { return [...this.map.values()].sort((a, b) => b.startedAt - a.startedAt); }
}

function createApi({ app, auth }) {
  const jobs = new Jobs();
  const { store, logs, log, supervisor, tunnel, backup, config, stats, telemetry, platform } = app;

  /** Routes reachable without a session. */
  const PUBLIC = new Set(['/session', '/bootstrap', '/terms']);

  return async function api(req, res, route) {
    const method = req.method;
    const url = new URL(req.url, 'http://localhost');

    // ---- public -----------------------------------------------------------

    if (route === '/bootstrap') {
      const check = auth.check(req);
      return json(res, 200, {
        version: app.version,
        needsPassword: !auth.configured,
        needsTerms: !store.get('termsAcceptedAt'),
        installed: app.installed(),
        authenticated: check.ok,
        authReason: check.reason || null,
        platform: { kind: platform.kind, label: platform.label },
        terms: TERMS,
      });
    }

    if (route === '/terms' && method === 'POST') {
      const body = await readJson(req);
      if (!body.accept) return json(res, 400, { error: 'Terms must be accepted to use this build' });
      store.set('termsAcceptedAt', new Date().toISOString());
      store.set('termsVersion', TERMS.version);
      return json(res, 200, { ok: true });
    }

    if (route === '/session' && method === 'POST') {
      const body = await readJson(req);

      // First run: choose the password (only possible from loopback).
      if (!auth.configured) {
        const check = auth.check(req);
        if (!check.ok) return json(res, 403, { error: 'Set the password from the machine itself first' });
        try {
          auth.setPassword(body.password);
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        const token = auth.issue();
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': auth.cookieHeader(token) });
        log.info('Control panel password set');
        return res.end(JSON.stringify({ ok: true, created: true }));
      }

      const token = auth.login(body.password);
      if (!token) {
        await new Promise((r) => setTimeout(r, 600));   // slow down guessing
        return json(res, 401, { error: 'Wrong password' });
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': auth.cookieHeader(token) });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (route === '/session' && method === 'DELETE') {
      auth.logout(req);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': auth.clearCookieHeader() });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ---- everything below needs a session ---------------------------------

    if (!PUBLIC.has(route)) {
      const check = auth.check(req);
      if (!check.ok) return json(res, 401, { error: 'Not signed in', reason: check.reason });
    }

    // ---- status & logs ----------------------------------------------------

    if (route === '/status') return json(res, 200, await app.status());

    if (route === '/logs') {
      const out = logs.tail({
        sinceId: Number(url.searchParams.get('since') || 0),
        source: url.searchParams.get('source') || 'all',
        level: url.searchParams.get('level') || 'all',
        search: url.searchParams.get('q') || null,
        limit: Math.min(2000, Number(url.searchParams.get('limit') || 500)),
      });
      return json(res, 200, { ...out, sources: ['all', 'manager', 'sillytavern', 'cloudflared', 'backup'] });
    }

    if (route === '/logs/download') {
      const source = url.searchParams.get('source') || 'all';
      const text = logs.asText(source);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="sillytavern-manager-${source}.log"`,
      });
      return res.end(text);
    }

    // ---- setup / installation --------------------------------------------

    if (route === '/versions') {
      try {
        return json(res, 200, await installer.listVersions());
      } catch (err) {
        return json(res, 502, { error: `Could not reach GitHub: ${err.message}` });
      }
    }

    if (route === '/install' && method === 'POST') {
      if (jobs.all().some((j) => j.kind === 'install' && j.state === 'running')) {
        return json(res, 409, { error: 'An installation is already running' });
      }
      const body = await readJson(req);
      const job = jobs.start('install', { selection: body.version || 'latest' });

      (async () => {
        try {
          await supervisor.stop().catch(() => {});
          const result = await installer.install({
            selection: body.version || 'latest',
            paths: platform,
            log: logs.logger('installer'),
            onProgress: (p) => jobs.update(job.id, {
              phase: p.phase,
              percent: Math.round(p.percent ?? job.percent),
              detail: p.version || p.line || null,
            }),
          });
          store.set('sillytavern.installedVersion', result.version);
          store.set('sillytavern.installedAt', new Date().toISOString());
          store.set('sillytavern.layout', result.layout);
          jobs.finish(job.id, { result });

          if (body.startAfter !== false) {
            supervisor.start();
            await supervisor.waitReady(180_000);
          }
          if (body.enableTunnel !== undefined) {
            store.set('tunnel.enabled', !!body.enableTunnel);
            if (body.enableTunnel) tunnel.start(app.port).catch(() => {});
            else await tunnel.stop();
          }
        } catch (err) {
          logs.logger('installer').error(err.message);
          jobs.fail(job.id, err);
        }
      })();

      return json(res, 202, { jobId: job.id });
    }

    if (route.startsWith('/jobs/')) {
      const job = jobs.get(route.slice('/jobs/'.length));
      return job ? json(res, 200, job) : json(res, 404, { error: 'No such job' });
    }
    if (route === '/jobs') return json(res, 200, { jobs: jobs.all() });

    // ---- SillyTavern process ---------------------------------------------

    if (route === '/sillytavern/start' && method === 'POST') {
      if (!app.installed()) return json(res, 400, { error: 'SillyTavern is not installed yet' });
      return json(res, 200, supervisor.start());
    }
    if (route === '/sillytavern/stop' && method === 'POST') {
      supervisor.autoRestart = false;
      const r = await supervisor.stop();
      supervisor.autoRestart = true;
      return json(res, 200, r);
    }
    if (route === '/sillytavern/restart' && method === 'POST') {
      return json(res, 200, await supervisor.restart());
    }

    // ---- tunnel ------------------------------------------------------------

    if (route === '/tunnel' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.enabled === 'boolean') {
        store.set('tunnel.enabled', body.enabled);
        if (body.enabled) await tunnel.start(app.port);
        else await tunnel.stop();
      }
      if (typeof body.webhookUrl === 'string') store.set('tunnel.webhookUrl', body.webhookUrl.trim());
      return json(res, 200, tunnel.info());
    }
    if (route === '/tunnel/restart' && method === 'POST') {
      await tunnel.stop();
      await tunnel.start(app.port);
      return json(res, 200, tunnel.info());
    }

    // ---- config.yaml -------------------------------------------------------

    if (route === '/config') {
      if (method === 'GET') return json(res, 200, await config.read());
      if (method === 'POST') {
        const body = await readJson(req);
        try {
          if (typeof body.raw === 'string') return json(res, 200, await config.writeRaw(body.raw));
          return json(res, 200, await config.patch(body.changes || {}));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
    }
    if (route === '/config/restore' && method === 'POST') {
      try { return json(res, 200, await config.restoreBackup()); }
      catch (err) { return json(res, 400, { error: err.message }); }
    }

    // ---- backups -----------------------------------------------------------

    if (route === '/backups') {
      const [local, remote] = await Promise.all([backup.listLocal(), backup.listRemote()]);
      return json(res, 200, {
        local, remote,
        profiles: PROFILES,
        status: backup.status(),
        settings: store.get('backup'),
      });
    }

    if (route === '/backups/estimate') {
      const est = await backup.estimate();
      return json(res, 200, { estimate: est, profiles: PROFILES });
    }

    if (route === '/backups/create' && method === 'POST') {
      const body = await readJson(req);
      const job = jobs.start('backup', { profile: body.profile || null });
      (async () => {
        try {
          const rec = await backup.create({
            profile: body.profile || null,
            upload: body.upload !== false,
            label: 'manual',
            force: true,
          });
          jobs.finish(job.id, { result: rec });
        } catch (err) { jobs.fail(job.id, err); }
      })();
      // Report archiving/upload progress into the job record.
      const tick = setInterval(() => {
        const r = backup.running;
        if (!r) return clearInterval(tick);
        const p = r.progress || {};
        const percent = p.phase === 'uploading' && p.total
          ? 50 + Math.round((p.sent / p.total) * 50)
          : Math.min(49, Math.round((p.files || 0) / 200));
        jobs.update(job.id, { phase: p.phase || 'working', percent, detail: p });
      }, 700);
      tick.unref?.();
      return json(res, 202, { jobId: job.id });
    }

    if (route === '/backups/settings' && method === 'POST') {
      const body = await readJson(req);
      const patch = body.settings || {};
      if (patch.remote && patch.remote.secretAccessKey === '********') delete patch.remote.secretAccessKey;
      if (patch.remote && /\*\*\*\*$/.test(patch.remote.accessKeyId || '')) delete patch.remote.accessKeyId;
      store.merge('backup', patch);
      backup.startSchedule();
      return json(res, 200, { ok: true, settings: store.redacted().backup });
    }

    if (route === '/backups/test-remote' && method === 'POST') {
      const body = await readJson(req);
      const r = { ...store.get('backup.remote'), ...(body.remote || {}) };
      if (r.secretAccessKey === '********') r.secretAccessKey = store.get('backup.remote.secretAccessKey');
      if (/\*\*\*\*$/.test(r.accessKeyId || '')) r.accessKeyId = store.get('backup.remote.accessKeyId');
      if (!r.endpoint || !r.bucket || !r.accessKeyId || !r.secretAccessKey) {
        return json(res, 400, { error: 'Endpoint, bucket, access key and secret are all required' });
      }
      try {
        const client = new S3Client({
          endpoint: r.endpoint, bucket: r.bucket, region: r.region || 'auto',
          accessKeyId: r.accessKeyId, secretAccessKey: r.secretAccessKey,
        });
        await client.testConnection();
        return json(res, 200, { ok: true, message: `Reached ${r.bucket} successfully` });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (route === '/backups/download') {
      const name = url.searchParams.get('name') || '';
      try {
        const file = backup.pathFor(name);
        const st = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': st.size,
          'content-disposition': `attachment; filename="${name}"`,
        });
        return fs.createReadStream(file).pipe(res);   // streamed, never buffered
      } catch (err) {
        return json(res, 404, { error: `No such backup: ${err.message}` });
      }
    }

    if (route === '/backups/upload' && method === 'POST') {
      // The whole request body is the zip. Streamed to disk.
      const name = (url.searchParams.get('name') || 'uploaded.zip').replace(/[^\w.@+-]/g, '_');
      const dest = path.join(platform.backupDir, `imported-${Date.now()}-${name}`);
      await fsp.mkdir(platform.backupDir, { recursive: true });
      try {
        const { bytes } = await streamToFile(req, dest);
        const info = await backup.inspect(dest);
        return json(res, 200, { ok: true, file: path.basename(dest), bytes, info });
      } catch (err) {
        await fsp.rm(dest, { force: true }).catch(() => {});
        return json(res, 400, { error: err.message });
      }
    }

    if (route === '/backups/inspect') {
      const name = url.searchParams.get('name') || '';
      try {
        return json(res, 200, await backup.inspect(backup.pathFor(name)));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (route === '/backups/restore' && method === 'POST') {
      const body = await readJson(req);
      const job = jobs.start('restore', { name: body.name });
      (async () => {
        try {
          let file;
          if (body.from === 'remote') {
            jobs.update(job.id, { phase: 'downloading', percent: 5 });
            const r = await backup.fetchRemote(body.name);
            file = r.path;
          } else {
            file = backup.pathFor(body.name);
          }
          jobs.update(job.id, { phase: 'restoring', percent: 30 });
          await supervisor.stop().catch(() => {});
          const result = await backup.restore(file, { wipe: !!body.wipe });
          jobs.finish(job.id, { result });
          supervisor.start();
        } catch (err) { jobs.fail(job.id, err); }
      })();
      const tick = setInterval(() => {
        const r = backup.running;
        if (!r) return clearInterval(tick);
        const p = r.progress || {};
        if (p.phase === 'extracting' && p.total) {
          jobs.update(job.id, { phase: 'restoring', percent: 30 + Math.round((p.done / p.total) * 65), detail: p });
        } else {
          jobs.update(job.id, { phase: p.phase || 'working', detail: p });
        }
      }, 700);
      tick.unref?.();
      return json(res, 202, { jobId: job.id });
    }

    if (route === '/backups/delete' && method === 'POST') {
      const body = await readJson(req);
      try {
        await fsp.rm(backup.pathFor(body.name), { force: true });
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // ---- usage -------------------------------------------------------------

    if (route === '/usage') {
      return json(res, 200, {
        ...stats.summary({ days: Math.min(180, Number(url.searchParams.get('days') || 30)) }),
        telemetry: telemetry.preview(),
      });
    }

    if (route === '/usage/reset' && method === 'POST') {
      await stats.reset();
      return json(res, 200, { ok: true });
    }

    // ---- settings ----------------------------------------------------------

    if (route === '/settings') {
      if (method === 'GET') return json(res, 200, store.redacted());
      if (method === 'POST') {
        const body = await readJson(req);
        if (body.password) {
          try { auth.setPassword(body.password); }
          catch (err) { return json(res, 400, { error: err.message }); }
        }
        if (body.sillytavern) store.merge('sillytavern', body.sillytavern);
        if (body.tunnel) store.merge('tunnel', body.tunnel);
        return json(res, 200, { ok: true, settings: store.redacted() });
      }
    }

    return json(res, 404, { error: `Unknown endpoint: ${route}` });
  };
}

module.exports = { createApi, readJson, streamToFile, Jobs };
