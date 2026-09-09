'use strict';
/**
 * Streaming-safe reverse proxy: public :7860 -> SillyTavern on 127.0.0.1:8000.
 *
 * Why hand-rolled instead of a proxy library: SillyTavern streams tokens as
 * `text/event-stream` over POST, and the whole product falls apart if anything
 * in the path buffers that. We pipe sockets directly and never touch
 * compression, so nothing can accumulate a buffer on the response side.
 *
 * Measured through a real trycloudflare quick tunnel:
 *   POST + text/event-stream -> streams incrementally  (SillyTavern's path: OK)
 *   GET  + text/event-stream -> buffered until close   (avoid EventSource!)
 *   WebSocket                -> streams incrementally
 * So the admin UI below uses polling/WebSocket, never EventSource.
 */
const http = require('http');
const { extractMeta } = require('./telemetry');

const GENERATE_RE = /^\/api\/backends\/[^/]+\/generate\b/;

/** Read the whole request body, capped. Returns null if over the cap. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
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
    req.on('error', reject);
  });
}

function createProxy(cfg, telemetry, log) {
  /** Forward `req` to SillyTavern, optionally with a pre-read body. */
  function forward(req, res, body, onDone) {
    const headers = { ...req.headers };
    delete headers['accept-encoding']; // keep the stream uncompressed & unbuffered

    // SillyTavern refuses requests whose Host header it does not recognise
    // (hostWhitelist). Behind this wrapper the real client is always us, on
    // loopback - and loopback/IP hosts are always trusted by SillyTavern. So
    // present the upstream Host as such, and keep the original for reference.
    if (headers.host) headers['x-forwarded-host'] = headers.host;
    headers.host = `127.0.0.1:${cfg.stPort}`;
    if (body) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    const upstream = http.request({
      host: cfg.stHost,
      port: cfg.stPort,
      method: req.method,
      path: req.url,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      // Disable Nagle so single SSE frames leave immediately.
      if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
      up.pipe(res);
      if (onDone) up.on('end', () => onDone(up.statusCode));
    });

    upstream.on('error', (err) => {
      log.error(`proxy upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('SillyTavern is not reachable yet. Give it a few seconds and reload.');
      if (onDone) onDone(502);
    });

    if (body) upstream.end(body);
    else req.pipe(upstream);
  }

  return async function proxy(req, res) {
    const isGenerate = req.method === 'POST' && GENERATE_RE.test(req.url.split('?')[0]);

    if (!isGenerate) return forward(req, res); // hot path: never buffered

    // Metered path. We buffer the REQUEST only, to read provider/model, and
    // discard it immediately. The RESPONSE is still piped straight through.
    let meta = {};
    let body = null;
    try {
      body = await readBody(req, cfg.maxTelemetryBodyBytes);
      if (body) {
        try {
          meta = extractMeta(JSON.parse(body.toString('utf8')));
        } catch { /* not JSON - forward untouched, record nothing */ }
      }
    } catch (err) {
      log.warn(`could not read request body: ${err.message}`);
    }

    const started = Date.now();
    forward(req, res, body, (status) => {
      telemetry.record(meta, {
        status,
        ok: status >= 200 && status < 400,
        durationMs: Date.now() - started,
      });
    });
  };
}

/** WebSocket / upgrade passthrough (SillyTavern extensions use these). */
function createUpgradeHandler(cfg, log) {
  const net = require('net');
  return function onUpgrade(req, socket, head) {
    const up = net.connect(cfg.stPort, cfg.stHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.setNoDelay(true);
      up.setNoDelay(true);
      up.pipe(socket);
      socket.pipe(up);
    });
    const bail = (err) => { log.warn(`upgrade failed: ${err.message}`); socket.destroy(); up.destroy(); };
    up.on('error', bail);
    socket.on('error', bail);
  };
}

module.exports = { createProxy, createUpgradeHandler, GENERATE_RE };
