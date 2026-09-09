'use strict';
/**
 * Reverse proxy from the manager's public port to SillyTavern on loopback.
 *
 * Everything here exists to protect token streaming. SillyTavern streams
 * generations as `text/event-stream` over POST, and any buffering in the path
 * turns a live typewriter effect into a long pause followed by a wall of text.
 * So: raw socket piping, no compression negotiation, Nagle disabled, and no
 * request timeout.
 *
 * The Host header is rewritten to loopback because SillyTavern's hostWhitelist
 * refuses hostnames it does not recognise - and behind this proxy the real
 * client always *is* loopback. The original is preserved in X-Forwarded-Host.
 */
const http = require('http');
const net = require('net');

function createProxy({ target, log, onGenerate = null }) {
  const GENERATE_RE = /^\/api\/backends\/[^/]+\/generate\b/;

  return function proxy(req, res) {
    const headers = { ...req.headers };

    // Never let an encoded response through: gzip would have to be buffered.
    delete headers['accept-encoding'];

    if (headers.host) headers['x-forwarded-host'] = headers.host;
    headers.host = `127.0.0.1:${target.port}`;
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';

    const started = Date.now();
    const isGenerate = req.method === 'POST' && GENERATE_RE.test((req.url || '').split('?')[0]);

    const upstream = http.request({
      host: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
      up.pipe(res);
      if (isGenerate && onGenerate) {
        up.on('end', () => onGenerate({
          status: up.statusCode,
          durationMs: Date.now() - started,
          meta: req._stmMeta || {},
        }));
      }
    });

    upstream.on('error', (err) => {
      log.warn(`proxy: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      }
      res.end(
        '<!doctype html><meta charset="utf-8"><title>SillyTavern is not running</title>'
        + '<body style="font:15px system-ui;padding:3rem;max-width:38rem;margin:auto">'
        + '<h1 style="font-size:1.25rem">SillyTavern is not running</h1>'
        + '<p>The manager could not reach SillyTavern on port ' + target.port + '.</p>'
        + '<p><a href="/manager">Open the control panel</a> to start it or read the logs.</p>',
      );
    });

    // If a generation body was already read for metering, replay it.
    if (req._stmBody) upstream.end(req._stmBody);
    else req.pipe(upstream);
  };
}

/** WebSocket / HTTP upgrade passthrough. */
function createUpgradeHandler({ target, log }) {
  return function onUpgrade(req, socket, head) {
    const up = net.connect(target.port, '127.0.0.1', () => {
      const headers = { ...req.headers };
      if (headers.host) headers['x-forwarded-host'] = headers.host;
      headers.host = `127.0.0.1:${target.port}`;

      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);

      socket.setNoDelay(true);
      up.setNoDelay(true);
      up.pipe(socket);
      socket.pipe(up);
    });
    const bail = (err) => {
      log.warn(`upgrade failed: ${err.message}`);
      socket.destroy();
      up.destroy();
    };
    up.on('error', bail);
    socket.on('error', bail);
  };
}

module.exports = { createProxy, createUpgradeHandler };
