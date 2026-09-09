'use strict';
/**
 * The single public listener.
 *
 *   /manager       control panel (login, setup, backups, logs, usage, config)
 *   /manager/api   REST
 *   everything else -> SillyTavern
 *
 * Serving SillyTavern at the root matters: SillyTavern is a single-page app
 * with absolute asset paths, so it cannot live under a path prefix without
 * rewriting its HTML. Keeping it at "/" also means one port and one tunnel URL
 * covers both the app and the panel - which is the only shape that works on
 * ModelScope, where 7860 is the only port that exists.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApp } = require('./app');
const { Auth } = require('./auth');
const { createApi } = require('./api');
const { createProxy, createUpgradeHandler } = require('./core/proxy');
const { extractRequestMeta, createUsageScanner } = require('./core/stats');

const PANEL = '/manager';
const WEB_DIR = path.join(__dirname, 'web');
const GENERATE_RE = /^\/api\/backends\/[^/]+\/generate\b/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

/**
 * Read a generation request so we can record which provider and model was used,
 * then hand the bytes on untouched. Prompts pass through this buffer but are
 * never stored, logged or transmitted - only the allowlisted fields in
 * stats.extractRequestMeta() survive.
 */
function readBodyForMetering(req, cap = 64 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (over) return;
      if (size > cap) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

async function start({ port = Number(process.env.PORT) || 7860, host = '0.0.0.0' } = {}) {
  const app = await createApp({ port });
  const auth = new Auth(app.store, app.log);
  const api = createApi({ app, auth });

  const proxy = createProxy({
    target: { get port() { return app.supervisor.port; } },
    log: app.log,
  });
  const upgrade = createUpgradeHandler({
    target: { get port() { return app.supervisor.port; } },
    log: app.log,
  });

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    try {
      // ---- control panel ------------------------------------------------
      if (pathname === PANEL || pathname === PANEL + '/') {
        // Stamp the asset URL with the version so upgrading the manager can
        // never leave a browser running last release's panel from cache.
        const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8')
          .replace(/__STM_VERSION__/g, app.version);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (pathname.startsWith(PANEL + '/api/')) {
        return await api(req, res, pathname.slice((PANEL + '/api').length) || '/');
      }

      if (pathname.startsWith(PANEL + '/')) {
        const rel = pathname.slice(PANEL.length + 1);
        if (rel.includes('..')) {
          res.writeHead(400);
          return res.end('Bad path');
        }
        return serveStatic(res, path.join(WEB_DIR, rel));
      }

      // ---- SillyTavern ----------------------------------------------------
      if (!app.installed()) {
        res.writeHead(302, { location: PANEL });
        return res.end();
      }

      // Meter generations without disturbing the stream.
      if (req.method === 'POST' && GENERATE_RE.test(pathname)) {
        const body = await readBodyForMetering(req);
        let meta = {};
        if (body) {
          try { meta = extractRequestMeta(JSON.parse(body.toString('utf8'))); }
          catch { /* not JSON: forward untouched, record nothing */ }
        }
        req._stmBody = body;

        const scanner = createUsageScanner();
        const started = Date.now();
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);
        let finished = false;

        // Watch the bytes going out; never delay or copy the stream.
        res.write = (chunk, ...rest) => {
          if (chunk) scanner.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return origWrite(chunk, ...rest);
        };
        res.end = (chunk, ...rest) => {
          if (chunk) scanner.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          if (!finished) {
            finished = true;
            const usage = scanner.result();
            const record = app.stats.record({
              ...meta, ...usage,
              status: res.statusCode,
              durationMs: Date.now() - started,
            });
            app.telemetry.record(record);
          }
          return origEnd(chunk, ...rest);
        };

        return proxy(req, res);
      }

      return proxy(req, res);
    } catch (err) {
      app.log.error(`Request failed (${pathname}): ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith(PANEL)) return socket.destroy();
    upgrade(req, socket, head);
  });

  // Generations can run for minutes; never time them out.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  app.log.info(`Control panel: http://localhost:${port}${PANEL}`);
  auth.announceSetup();

  await app.begin();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    await app.shutdown(signal);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => app.log.error(`Uncaught: ${err.stack}`));
  process.on('unhandledRejection', (err) => app.log.error(`Unhandled rejection: ${err}`));

  return { app, server, auth };
}

module.exports = { start, PANEL };
