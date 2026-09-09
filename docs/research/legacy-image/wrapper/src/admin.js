'use strict';
/**
 * Admin API + UI, mounted under /_admin.
 *
 * Auth note: this sits on a public trycloudflare URL, so it is password
 * protected independently of SillyTavern's own login. The password comes from
 * ADMIN_PASSWORD, or is generated on first boot and printed to the logs.
 *
 * Transport note: no EventSource anywhere. GET + text/event-stream is buffered
 * by Cloudflare quick tunnels (measured), so live views here poll instead.
 */
const crypto = require('crypto');
const fsp = require('fs/promises');
const { dirSize } = require('./storage');

const json = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
};

function readRaw(req, cap = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createAdmin(ctx) {
  const { cfg, state, log, telemetry, backup, tunnel, st } = ctx;

  // Session tokens live in memory only; a restart logs everyone out.
  const sessions = new Set();

  function password() {
    let p = cfg.adminPassword || state.get('adminPassword');
    if (!p) {
      p = crypto.randomBytes(9).toString('base64url');
      state.set('adminPassword', p);
    }
    return p;
  }

  // Print on EVERY boot, not just the first. Platform log capture often starts
  // a few seconds late and swallows the opening lines, and a generated password
  // that was only ever printed once is a password you have lost.
  function announcePassword() {
    const bar = '='.repeat(60);
    log.info(bar);
    log.info('ADMIN PASSWORD: ' + password());
    log.info('Set ADMIN_PASSWORD in the Studio env vars to pin your own.');
    log.info(bar);
  }
  announcePassword();
  setTimeout(announcePassword, 30_000).unref?.(); // again, once logs are attached

  function authed(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/stw_session=([\w.-]+)/);
    if (m && sessions.has(m[1])) return true;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return sessions.has(auth.slice(7));
    return false;
  }

  async function status() {
    const [data, backups] = await Promise.all([
      dirSize(cfg.dataDir).catch(() => ({ bytes: 0, files: 0 })),
      backup.listLocal(),
    ]);
    return {
      persistence: ctx.persistence,
      paths: { root: cfg.persistRoot, data: cfg.dataDir, config: cfg.configDir },
      storage: data,
      sillytavern: { running: st.running(), pid: st.pid(), restarts: st.restarts },
      tunnel: tunnel.info(),
      telemetry: {
        enabled: telemetry.enabled,
        consent: state.get('telemetryConsent') !== false,
        configured: !!cfg.telemetryEndpoint,
        endpoint: cfg.telemetryEndpoint || null,
        queued: telemetry.queue.length,
        recentFlushes: telemetry.sent.slice(-10),
      },
      backups: {
        local: backups.length,
        remoteEnabled: backup.remoteEnabled,
        last: backup.last,
      },
      installId: state.get('installId'),
      uptimeSec: Math.round(process.uptime()),
    };
  }

  return async function admin(req, res, pathname) {
    const route = pathname.slice(cfg.adminPrefix.length) || '/';

    // ---- public routes ---------------------------------------------------
    if (route === '/' || route === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(require('./ui').page());
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readRaw(req, 4096).catch(() => Buffer.alloc(0));
      let given = '';
      try { given = String(JSON.parse(body.toString() || '{}').password || ''); } catch { /* ignore */ }
      const expect = password();
      const a = Buffer.from(given);
      const b = Buffer.from(expect);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 500)); // slow down guessing
        return json(res, 401, { error: 'wrong password' });
      }
      const token = crypto.randomBytes(24).toString('base64url');
      sessions.add(token);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'stw_session=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400',
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // The disclosure must be readable WITHOUT logging in - it is the whole
    // basis on which the user agreed to run this thing.
    if (route === '/api/disclosure') {
      return json(res, 200, {
        collected: [
          'Anonymous install ID (a random UUID generated on this machine)',
          'Which AI provider each generation used (openai, claude, gemini, custom, ...)',
          'Model name',
          'Endpoint hostname only - never the path or query string',
          'Whether streaming was on, and the max_tokens budget you set',
          'Response status code and how long the call took',
        ],
        neverCollected: [
          'API keys of any kind',
          'Prompts, messages, chat logs, or model output',
          'Character cards, personas, lorebooks, world info',
          'Your name, email, IP address, or SillyTavern account details',
          'Request or response bodies',
          'URL paths or query strings',
        ],
        endpoint: cfg.telemetryEndpoint || null,
        consent: state.get('telemetryConsent') !== false,
      });
    }

    // ---- everything below needs a session --------------------------------
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

    if (route === '/api/status') return json(res, 200, await status());
    if (route === '/api/logs') return json(res, 200, { lines: log.tail(300) });

    if (route === '/api/telemetry/summary') {
      return json(res, 200, { rows: telemetry.summary(), preview: telemetry.preview() });
    }

    if (route === '/api/telemetry/consent' && req.method === 'POST') {
      const body = await readRaw(req, 4096).catch(() => Buffer.alloc(0));
      let value = true;
      try { value = !!JSON.parse(body.toString() || '{}').consent; } catch { /* ignore */ }
      state.set('telemetryConsent', value);
      log.info('telemetry consent set to ' + value);
      return json(res, 200, { consent: value });
    }

    if (route === '/api/backups') {
      const [local, remote] = await Promise.all([backup.listLocal(), backup.listRemote()]);
      return json(res, 200, { local, remote, remoteEnabled: backup.remoteEnabled });
    }

    if (route === '/api/backup' && req.method === 'POST') {
      try {
        return json(res, 200, await backup.create({ upload: true, label: 'manual' }));
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (route === '/api/restore' && req.method === 'POST') {
      const body = await readRaw(req, 8192).catch(() => Buffer.alloc(0));
      let name = '';
      let from = 'local';
      try {
        const parsed = JSON.parse(body.toString() || '{}');
        name = parsed.name || '';
        from = parsed.from || 'local';
      } catch { /* ignore */ }
      try {
        const out = await backup.restore(name, { from });
        st.restart();
        return json(res, 200, out);
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // Raw-body upload: POST the .tar.gz as the entire request body.
    if (route === '/api/upload' && req.method === 'POST') {
      try {
        const buf = await readRaw(req);
        if (!buf.length) return json(res, 400, { error: 'empty upload' });
        const out = await backup.importArchive(buf, 'upload.tar.gz');
        st.restart();
        return json(res, 200, out);
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (route === '/api/download' && req.method === 'GET') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      if (!/^[\w.-]+\.tar\.gz$/.test(name)) return json(res, 400, { error: 'invalid name' });
      try {
        const buf = await fsp.readFile(cfg.backupDir + '/' + name);
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-disposition': 'attachment; filename="' + name + '"',
          'content-length': buf.length,
        });
        return res.end(buf);
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }

    if (route === '/api/restart' && req.method === 'POST') {
      st.restart();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'no such admin route' });
  };
}

module.exports = { createAdmin };
