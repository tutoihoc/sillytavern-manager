'use strict';
/**
 * Cloudflare quick tunnel (trycloudflare.com) so the user can reach
 * SillyTavern from a phone without port-forwarding or a domain.
 *
 * Measured behaviour of quick tunnels, which shapes the whole design:
 *   POST + text/event-stream  streams incrementally  <- SillyTavern's token
 *                                                       streaming works
 *   GET  + text/event-stream  buffered until close   <- never build a live
 *                                                       view on EventSource
 *   WebSocket                 streams incrementally
 * Plus a hard 200 concurrent in-flight request cap, and no SLA.
 *
 * The hostname is random and changes on every start, so we announce each new
 * URL to an optional webhook and keep the last one in the UI.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { download } = require('./installer');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/** Which cloudflared build fits this machine? */
function assetName() {
  const arch = process.arch;   // x64 | arm64 | arm
  const map = {
    x64: 'amd64',
    arm64: 'arm64',
    arm: 'arm',
    ia32: '386',
  };
  const a = map[arch];
  if (!a) throw new Error(`no cloudflared build for CPU architecture "${arch}"`);

  if (process.platform === 'win32') return { file: `cloudflared-windows-${a}.exe`, exe: 'cloudflared.exe' };
  if (process.platform === 'darwin') {
    // Cloudflare only ships macOS as a .tgz; we cannot unpack tar without a
    // dependency, so ask the user to use Homebrew instead of failing obscurely.
    throw new Error('On macOS install cloudflared with `brew install cloudflared`, then set CLOUDFLARED_BIN.');
  }
  // Android/Termux is linux-arm64 in practice.
  return { file: `cloudflared-linux-${a}`, exe: 'cloudflared' };
}

class Tunnel {
  constructor({ paths, store, logs }) {
    this.paths = paths;
    this.store = store;
    this.logs = logs;
    this.log = logs.logger('cloudflared');
    this.mlog = logs.logger('manager');

    this.child = null;
    this.url = null;
    this.state = 'stopped';    // stopped | installing | starting | up | retrying | error
    this.error = null;
    this.restarts = 0;
    this.stopping = false;
    this.listeners = new Set();
  }

  onUrl(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  info() {
    return {
      enabled: this.store.get('tunnel.enabled', true),
      state: this.state,
      url: this.url,
      error: this.error,
      restarts: this.restarts,
      binary: this.binaryPath(),
    };
  }

  binaryPath() {
    if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
    try {
      return path.join(this.paths.binDir, assetName().exe);
    } catch {
      return null;
    }
  }

  async ensureBinary(onProgress) {
    const bin = this.binaryPath();
    if (!bin) throw new Error('cloudflared is not available for this platform');
    if (process.env.CLOUDFLARED_BIN) return bin;
    if (fs.existsSync(bin)) return bin;

    const { file } = assetName();
    this.state = 'installing';
    this.mlog.info(`Downloading cloudflared (${file})...`);
    await fsp.mkdir(this.paths.binDir, { recursive: true });

    const tmp = `${bin}.part`;
    await download(`${RELEASE}/${file}`, tmp, ({ received, total }) => {
      if (onProgress && total) onProgress({ percent: Math.round((received / total) * 100) });
    });
    await fsp.rename(tmp, bin);
    if (process.platform !== 'win32') await fsp.chmod(bin, 0o755);
    this.mlog.info('cloudflared installed');
    return bin;
  }

  /** Point the tunnel at the manager's own port so one URL serves everything. */
  async start(targetPort) {
    if (this.child) return { alreadyRunning: true, url: this.url };
    if (!this.store.get('tunnel.enabled', true)) {
      this.state = 'stopped';
      return { disabled: true };
    }

    this.stopping = false;
    this.error = null;

    let bin;
    try {
      bin = await this.ensureBinary();
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.mlog.error(`Tunnel unavailable: ${err.message}`);
      return { error: err.message };
    }

    this.state = 'starting';
    this.mlog.info('Starting Cloudflare quick tunnel...');

    this.child = spawn(bin, [
      'tunnel', '--no-autoupdate',
      '--url', `http://127.0.0.1:${targetPort}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    const scan = (buf) => {
      const text = String(buf);
      this.logs.pushChunk('cloudflared', /ERR|error/i.test(text) ? 'error' : 'info', text);
      const m = text.match(URL_RE);
      if (m && m[0] !== this.url) {
        this.url = m[0];
        this.state = 'up';
        this.store.set('tunnel.lastUrl', this.url);
        this.mlog.info(`Public URL: ${this.url}`);
        for (const fn of this.listeners) {
          try { fn(this.url); } catch { /* announcing is best effort */ }
        }
      }
    };
    this.child.stdout.on('data', scan);
    this.child.stderr.on('data', scan);   // cloudflared prints the URL on stderr

    this.child.on('error', (err) => {
      this.state = 'error';
      this.error = err.message;
      this.mlog.error(`cloudflared failed: ${err.message}`);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      this.url = null;
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      this.state = 'retrying';
      this.restarts++;
      const delay = Math.min(60_000, 2000 * this.restarts);
      this.mlog.warn(`Tunnel dropped (code ${code}); reconnecting in ${Math.round(delay / 1000)}s`);
      this._timer = setTimeout(() => this.start(targetPort), delay);
      this._timer.unref?.();
    });

    return { starting: true };
  }

  async stop() {
    this.stopping = true;
    if (this._timer) clearTimeout(this._timer);
    if (!this.child) {
      this.state = 'stopped';
      this.url = null;
      return { alreadyStopped: true };
    }
    const child = this.child;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    this.state = 'stopped';
    this.url = null;
    return { stopped: true };
  }
}

/** Post a freshly minted URL somewhere the owner will actually see it. */
async function announce(webhookUrl, tunnelUrl, log) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `SillyTavern is available at ${tunnelUrl}`,
        text: `SillyTavern is available at ${tunnelUrl}`,   // Slack-shaped
      }),
      signal: AbortSignal.timeout(10_000),
    });
    log.info('Announced the new tunnel URL to your webhook');
  } catch (err) {
    log.warn(`Webhook announce failed: ${err.message}`);
  }
}

module.exports = { Tunnel, announce, assetName, URL_RE };
