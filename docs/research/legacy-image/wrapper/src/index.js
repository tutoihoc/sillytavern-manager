'use strict';
/**
 * Entry point. One public listener on :7860 (all ModelScope Studios expose),
 * fronting SillyTavern on loopback:8000.
 *
 *   internet ──▶ trycloudflare ──┐
 *                                ├──▶ :7860 wrapper ──▶ 127.0.0.1:8000 SillyTavern
 *   ModelScope Studio iframe ────┘        └── /_admin  (control panel)
 */
const http = require('http');
const { spawn } = require('child_process');

const cfg = require('./config');
const log = require('./log');
const { State, initLayout, checkPersistence } = require('./storage');
const { Telemetry, newInstallId } = require('./telemetry');
const { Backup } = require('./backup');
const { Tunnel, announce } = require('./tunnel');
const { createProxy, createUpgradeHandler } = require('./proxy');
const { createAdmin } = require('./admin');

/** Supervises the SillyTavern node process and restarts it if it dies. */
class SillyTavern {
  constructor() {
    this.proc = null;
    this.restarts = 0;
    this.stopping = false;
  }
  running() { return !!this.proc; }
  pid() { return this.proc ? this.proc.pid : null; }

  start() {
    if (this.proc) return;
    log.info('starting SillyTavern...');
    this.proc = spawn('node', ['server.js', '--port', String(cfg.stPort), '--listen'], {
      cwd: cfg.stAppDir,
      env: {
        ...process.env,
        // Bind to loopback: the wrapper is the only thing allowed to reach it.
        SILLYTAVERN_LISTEN: 'true',
        SILLYTAVERN_PORT: String(cfg.stPort),
        SILLYTAVERN_LISTENADDRESS_IPV4: '127.0.0.1',
        SILLYTAVERN_PROTOCOL_IPV6: 'false',
        // The wrapper terminates the public edge, so ST's own IP allowlist
        // would only ever see 127.0.0.1. Auth lives in ST's user accounts.
        SILLYTAVERN_WHITELISTMODE: 'false',
        SILLYTAVERN_SECURITYOVERRIDE: 'true',
        SILLYTAVERN_DATAROOT: cfg.dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const relay = (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (line.trim()) log.info('[st] ' + line.trim());
      }
    };
    this.proc.stdout.on('data', relay);
    this.proc.stderr.on('data', relay);

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      this.restarts++;
      log.warn(`SillyTavern exited (code ${code}); restarting in 3s`);
      setTimeout(() => this.start(), 3000).unref?.();
    });
  }

  restart() {
    log.info('restarting SillyTavern on request');
    if (this.proc) this.proc.kill('SIGTERM');
    else this.start();
  }

  stop() {
    this.stopping = true;
    if (this.proc) this.proc.kill('SIGTERM');
  }
}

async function main() {
  log.info('SillyTavern wrapper starting');

  // 1. Storage first - everything else depends on knowing whether we persist.
  const persistence = await checkPersistence(cfg, log);
  await initLayout(cfg, log);
  const state = new State(cfg.stateDir + '/state.json');
  if (!state.get('installId')) state.set('installId', newInstallId());
  log.info(`install id ${state.get('installId')}`);
  log.info(persistence.persistent
    ? `persistent volume OK at ${cfg.persistRoot}`
    : 'WARNING: storage is NOT persistent - chats will be lost on restart');

  // 2. Subsystems.
  const telemetry = new Telemetry(cfg, state, log);
  const backup = new Backup(cfg, log);
  const tunnel = new Tunnel(cfg, log);
  const st = new SillyTavern();

  const ctx = { cfg, state, log, telemetry, backup, tunnel, st, persistence };
  const admin = createAdmin(ctx);
  const proxy = createProxy(cfg, telemetry, log);

  // 3. Public listener.
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === cfg.adminPrefix || pathname.startsWith(cfg.adminPrefix + '/')) {
      admin(req, res, pathname).catch((err) => {
        log.error('admin error: ' + err.message);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }
    proxy(req, res);
  });
  server.on('upgrade', createUpgradeHandler(cfg, log));
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;      // long generations must not be cut off
  server.timeout = 0;

  await new Promise((resolve) => server.listen(cfg.publicPort, '0.0.0.0', resolve));
  log.info(`wrapper listening on 0.0.0.0:${cfg.publicPort}  (admin at ${cfg.adminPrefix})`);

  // 4. Start the app, the tunnel and the schedules.
  st.start();
  telemetry.start();
  backup.startSchedule();
  tunnel.onUrl((url) => announce(cfg.tunnelWebhook, url, log));
  tunnel.start();

  // 5. Shut down cleanly so the last telemetry batch and a final backup land.
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig} received; shutting down`);
    tunnel.stop();
    st.stop();
    telemetry.stop();
    backup.stop();
    await telemetry.flush().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => log.error('uncaught: ' + err.stack));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection: ' + err));
}

main().catch((err) => {
  log.error('fatal: ' + err.stack);
  process.exit(1);
});
