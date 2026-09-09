'use strict';
/**
 * Runs SillyTavern as a child process and pipes everything it prints into the
 * log hub, so the user can read startup codes, warnings and errors from the
 * browser without ever opening a terminal.
 *
 * SillyTavern is bound to loopback and reached through our proxy. That means
 * SillyTavern only ever sees 127.0.0.1 as the client, so its own IP whitelist
 * would protect nothing - real access control is the manager's login plus
 * SillyTavern's user accounts / basic auth, both configurable in the UI.
 */
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const READY_RE = /SillyTavern is listening on|Go to: http|Launching in a browser/i;

class Supervisor {
  constructor({ paths, store, logs }) {
    this.paths = paths;
    this.store = store;
    this.logs = logs;
    this.log = logs.logger('sillytavern');
    this.mlog = logs.logger('manager');

    this.child = null;
    this.state = 'stopped';     // stopped | starting | running | crashed
    this.startedAt = null;
    this.restarts = 0;
    this.lastExit = null;
    this.autoRestart = true;
    this.stopping = false;
    this._backoff = 0;
  }

  get port() {
    return this.store.get('sillytavern.port', 8000);
  }

  status() {
    return {
      state: this.state,
      pid: this.child ? this.child.pid : null,
      port: this.port,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      lastExit: this.lastExit,
    };
  }

  start() {
    if (this.child) return { alreadyRunning: true };
    this.stopping = false;

    const port = this.port;
    this.state = 'starting';
    this.mlog.info(`Starting SillyTavern on 127.0.0.1:${port}`);

    this.child = spawn(process.execPath, ['server.js'], {
      cwd: this.paths.stRoot,
      env: {
        ...process.env,
        // Bind to loopback; the manager is the only thing that talks to it.
        SILLYTAVERN_LISTEN: 'true',
        SILLYTAVERN_PORT: String(port),
        SILLYTAVERN_LISTENADDRESS_IPV4: '127.0.0.1',
        SILLYTAVERN_PROTOCOL_IPV6: 'false',
        SILLYTAVERN_WHITELISTMODE: 'false',
        SILLYTAVERN_SECURITYOVERRIDE: 'true',
        SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false',
        // NOTE: never set SILLYTAVERN_HOSTWHITELIST_ENABLED here. Its call site
        // does `!!getConfigValue(...)` without a boolean converter, so the
        // string "false" arrives truthy and switches the whitelist ON.
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.startedAt = Date.now();

    this.child.stdout.on('data', (d) => {
      const text = String(d);
      this.logs.pushChunk('sillytavern', 'info', text);
      if (this.state === 'starting' && READY_RE.test(text)) {
        this.state = 'running';
        this._backoff = 0;
        this.mlog.info('SillyTavern is ready');
      }
    });

    this.child.stderr.on('data', (d) => {
      const text = String(d);
      // SillyTavern writes ordinary notices to stderr too; only flag real errors.
      this.logs.pushChunk('sillytavern', /error|exception|EADDRINUSE/i.test(text) ? 'error' : 'info', text);
    });

    this.child.on('error', (err) => {
      this.state = 'crashed';
      this.mlog.error(`Could not start SillyTavern: ${err.message}`);
    });

    this.child.on('exit', (code, signal) => {
      const wasRunning = this.state === 'running';
      this.child = null;
      this.lastExit = { code, signal, at: Date.now() };
      this.startedAt = null;

      if (this.stopping) {
        this.state = 'stopped';
        this.mlog.info('SillyTavern stopped');
        return;
      }

      this.state = 'crashed';
      this.mlog.error(`SillyTavern exited (code ${code}${signal ? `, signal ${signal}` : ''})`);

      if (this.autoRestart) {
        // Back off so a config error does not spin the CPU restarting forever.
        this._backoff = wasRunning ? 2000 : Math.min(60_000, (this._backoff || 2000) * 2);
        this.restarts++;
        this.mlog.info(`Restarting in ${Math.round(this._backoff / 1000)}s`);
        this._timer = setTimeout(() => this.start(), this._backoff);
        this._timer.unref?.();
      }
    });

    return { started: true, port };
  }

  async stop({ timeoutMs = 10_000 } = {}) {
    if (this._timer) clearTimeout(this._timer);
    if (!this.child) {
      this.state = 'stopped';
      return { alreadyStopped: true };
    }
    this.stopping = true;
    const child = this.child;
    this.mlog.info('Stopping SillyTavern...');
    child.kill('SIGTERM');

    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => { clearTimeout(t); resolve(true); });
    });

    if (!exited) {
      this.mlog.warn('SillyTavern did not exit in time; forcing');
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this.state = 'stopped';
    return { stopped: true };
  }

  async restart() {
    await this.stop();
    this.stopping = false;
    return this.start();
  }

  /** Is something already listening on the SillyTavern port? */
  probe(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port });
      const done = (ok) => { sock.destroy(); resolve(ok); };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  /** Wait until SillyTavern answers, or give up. */
  async waitReady(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe()) {
        if (this.state !== 'running') this.state = 'running';
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }
}

module.exports = { Supervisor };
