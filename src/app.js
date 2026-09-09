'use strict';
/**
 * Composition root: builds every subsystem, wires them together and owns the
 * lifecycle. Everything the API layer needs hangs off the returned object.
 */
const path = require('path');
const platform = require('./core/platform');
const { Store } = require('./core/store');
const { LogHub } = require('./core/logs');
const { Supervisor } = require('./core/supervisor');
const { Tunnel, announce } = require('./core/tunnel');
const { BackupManager } = require('./core/backup');
const { ConfigEditor } = require('./core/configEditor');
const { Stats } = require('./core/stats');
const { Telemetry } = require('./core/telemetry');
const ST = require('./core/sillytavern');

const VERSION = require('../package.json').version;

async function createApp({ port = Number(process.env.PORT) || 7860 } = {}) {
  platform.ensureDirs();

  const logs = new LogHub(platform.logDir);
  const log = logs.logger('manager');
  const store = new Store(path.join(platform.stateDir, 'settings.json'));

  log.info(`SillyTavern Manager ${VERSION}`);
  log.info(`Platform: ${platform.label}${platform.container ? ' (container)' : ''}`);
  log.info(`Data directory: ${platform.home}`);
  if (!platform.durability.durable) {
    log[platform.durability.unknown ? 'warn' : 'error'](platform.durability.reason);
  }

  const stats = new Stats({ stateDir: platform.stateDir, log });
  await stats.load();

  const telemetry = new Telemetry({ store, logs, version: VERSION, platform });

  const supervisor = new Supervisor({ paths: platform, store, logs });
  const tunnel = new Tunnel({ paths: platform, store, logs });

  /** Where SillyTavern keeps this install's user data, or null before setup. */
  const currentUser = () => store.get('sillytavern.user', ST.DEFAULT_USER);
  const getDataDir = () => {
    const layout = store.get('sillytavern.layout') || ST.detectLayout(platform.stRoot);
    if (!layout) return null;
    return ST.userDataDir(platform.stRoot, layout, currentUser());
  };

  const backup = new BackupManager({ paths: platform, store, logs, getDataDir });
  const config = new ConfigEditor({ stRoot: platform.stRoot, log: logs.logger('manager') });

  tunnel.onUrl((url) => announce(store.get('tunnel.webhookUrl', ''), url, log));

  const app = {
    version: VERSION,
    port,
    platform,
    paths: platform,
    store,
    logs,
    log,
    stats,
    telemetry,
    supervisor,
    tunnel,
    backup,
    config,
    ST,
    getDataDir,
    currentUser,

    installed() {
      return ST.isInstalled(platform.stRoot);
    },

    /** Everything the dashboard needs in one call. */
    async status() {
      const layout = store.get('sillytavern.layout') || ST.detectLayout(platform.stRoot);
      const dataDir = getDataDir();
      return {
        version: VERSION,
        platform: {
          kind: platform.kind,
          label: platform.label,
          container: platform.container,
          home: platform.home,
          durability: platform.durability,
        },
        setup: {
          installed: app.installed(),
          version: store.get('sillytavern.installedVersion'),
          installedAt: store.get('sillytavern.installedAt'),
          layout,
          dataDir,
          user: currentUser(),
          termsAcceptedAt: store.get('termsAcceptedAt'),
        },
        sillytavern: supervisor.status(),
        tunnel: tunnel.info(),
        backup: backup.status(),
        telemetry: telemetry.status(),
        managerPort: port,
      };
    },

    /** Start background work once the HTTP server is listening. */
    async begin() {
      telemetry.start();

      if (app.installed()) {
        const layout = ST.detectLayout(platform.stRoot);
        if (layout) store.set('sillytavern.layout', layout);
        if (store.get('sillytavern.autoStart', true)) supervisor.start();
      } else {
        log.info('SillyTavern is not installed yet - open the control panel to set it up');
      }

      if (store.get('tunnel.enabled', true)) {
        tunnel.start(port).catch((err) => log.warn(`Tunnel: ${err.message}`));
      }

      backup.startSchedule();
    },

    async shutdown(reason = 'shutdown') {
      log.info(`Shutting down (${reason})`);
      backup.stopSchedule();
      telemetry.stop();
      await stats.flush().catch(() => {});
      await telemetry.flush().catch(() => {});
      await backup.onShutdown().catch(() => {});
      await tunnel.stop().catch(() => {});
      await supervisor.stop().catch(() => {});
      log.info('Goodbye');
    },
  };

  return app;
}

module.exports = { createApp, VERSION };
