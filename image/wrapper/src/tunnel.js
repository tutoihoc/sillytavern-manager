'use strict';
/**
 * Supervises a cloudflared *quick tunnel* (trycloudflare.com).
 *
 * Two things to know about quick tunnels, both of which shape this file:
 *  1. The hostname is random and changes on EVERY start. The Studio sleeps
 *     when idle, so the URL rotates in practice - hence the webhook announce.
 *  2. When the Studio is asleep the tunnel is dead. Hitting the trycloudflare
 *     URL will NOT wake it; only the ModelScope Studio page does. Users need
 *     both links.
 * Documented quick-tunnel limits: 200 in-flight requests, no SLA.
 */
const { spawn } = require('child_process');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

class Tunnel {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.url = null;
    this.proc = null;
    this.status = 'stopped';
    this.restarts = 0;
    this.stopping = false;
    this.listeners = [];
  }

  onUrl(fn) { this.listeners.push(fn); }

  start() {
    if (!this.cfg.tunnelEnabled) { this.status = 'disabled'; return; }
    if (this.proc) return;

    this.status = 'starting';
    this.log.info('starting cloudflared quick tunnel...');
    this.proc = spawn(this.cfg.tunnelBin, [
      'tunnel', '--no-autoupdate',
      '--url', `http://127.0.0.1:${this.cfg.publicPort}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const scan = (buf) => {
      const text = buf.toString();
      const m = text.match(URL_RE);
      if (m && m[0] !== this.url) {
        this.url = m[0];
        this.status = 'up';
        this.log.info(`tunnel URL: ${this.url}`);
        for (const fn of this.listeners) {
          try { fn(this.url); } catch { /* announce is best-effort */ }
        }
      }
    };
    this.proc.stdout.on('data', scan);
    this.proc.stderr.on('data', scan); // cloudflared logs the URL on stderr

    this.proc.on('exit', (code) => {
      this.proc = null;
      this.url = null;
      if (this.stopping) { this.status = 'stopped'; return; }
      this.status = 'restarting';
      this.restarts++;
      const delay = Math.min(60_000, 2000 * this.restarts);
      this.log.warn(`cloudflared exited (code ${code}); restarting in ${delay}ms`);
      setTimeout(() => this.start(), delay).unref?.();
    });
  }

  stop() {
    this.stopping = true;
    if (this.proc) this.proc.kill('SIGTERM');
  }

  info() {
    return { status: this.status, url: this.url, restarts: this.restarts };
  }
}

/** Post the new URL somewhere the owner will see it (Discord/Slack webhook). */
async function announce(webhookUrl, tunnelUrl, log) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `SillyTavern is up: ${tunnelUrl}`,
        text: `SillyTavern is up: ${tunnelUrl}`, // Slack-compatible
      }),
      signal: AbortSignal.timeout(10_000),
    });
    log.info('announced tunnel URL to webhook');
  } catch (err) {
    log.warn(`webhook announce failed: ${err.message}`);
  }
}

module.exports = { Tunnel, announce, URL_RE };
