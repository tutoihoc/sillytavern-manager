#!/usr/bin/env node
'use strict';
/**
 * Command line entry point.
 *
 *   stm                 start the manager (default)
 *   stm start --port N  start on a specific port
 *   stm status          print where things live and whether they persist
 *   stm reset-password  clear the panel password (then set a new one locally)
 *   stm --version
 */
const path = require('path');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v === undefined ? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true) : v;
    } else if (a.startsWith('-') && a.length === 2) {
      args[a[1]] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'start';

  if (args.version || args.v || command === 'version') {
    console.log(require('../package.json').version);
    return;
  }

  if (args.help || args.h || command === 'help') {
    console.log(`SillyTavern Manager ${require('../package.json').version}

Usage:
  stm [start]              Start the manager and control panel
  stm status               Show paths, platform and whether data persists
  stm reset-password       Forget the control panel password

Options:
  --port <n>               Port for the control panel (default 7860, or $PORT)
  --host <addr>            Bind address (default 0.0.0.0)
  --no-tunnel              Start with the Cloudflare tunnel switched off

Environment:
  STM_HOME                 Override where data is stored
  CLOUDFLARED_BIN          Use an existing cloudflared binary
  STM_TELEMETRY_ENDPOINT   Usage reporting endpoint
`);
    return;
  }

  if (command === 'status') {
    const platform = require('../src/core/platform');
    const { Store } = require('../src/core/store');
    const ST = require('../src/core/sillytavern');
    platform.ensureDirs();
    const store = new Store(path.join(platform.stateDir, 'settings.json'));
    console.log(`Platform      ${platform.label}${platform.container ? ' (container)' : ''}`);
    console.log(`Home          ${platform.home}`);
    console.log(`Persistent    ${platform.durability.durable ? 'yes' : 'NO'} - ${platform.durability.reason}`);
    console.log(`SillyTavern   ${ST.isInstalled(platform.stRoot) ? store.get('sillytavern.installedVersion') || 'installed' : 'not installed'}`);
    console.log(`Layout        ${ST.detectLayout(platform.stRoot) || '-'}`);
    console.log(`Data dir      ${ST.userDataDir(platform.stRoot, ST.detectLayout(platform.stRoot) || 'data')}`);
    console.log(`Backups       ${platform.backupDir}`);
    console.log(`Tunnel        ${store.get('tunnel.enabled') ? 'enabled' : 'disabled'}  ${store.get('tunnel.lastUrl') || ''}`);
    return;
  }

  if (command === 'reset-password') {
    const platform = require('../src/core/platform');
    const { Store } = require('../src/core/store');
    platform.ensureDirs();
    const store = new Store(path.join(platform.stateDir, 'settings.json'));
    store.set('adminPasswordHash', null);
    store.set('adminPasswordSalt', null);
    console.log('Password cleared. Open the control panel on this machine to set a new one.');
    return;
  }

  if (command !== 'start') {
    console.error(`Unknown command "${command}". Try: stm help`);
    process.exitCode = 1;
    return;
  }

  if (args['no-tunnel']) process.env.STM_TUNNEL_DISABLED = '1';

  const { start } = require('../src/server');
  const port = Number(args.port || process.env.PORT || 7860);
  const host = String(args.host || '0.0.0.0');

  try {
    await start({ port, host });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: stm --port ${port + 1}`);
    } else {
      console.error(`Failed to start: ${err && err.message ? err.message : err}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
