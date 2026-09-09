'use strict';
/**
 * Where are we running, and where is it safe to write?
 *
 * The manager has to behave sensibly on four very different hosts:
 *
 *   windows    a normal PC                      -> %LOCALAPPDATA%
 *   termux     Android, no /usr, no root        -> $PREFIX/var or ~/.local/share
 *   modelscope free Studio, container wiped on  -> /mnt/workspace (the ONLY
 *              restart except one mounted path      directory that survives)
 *   linux      VPS / desktop / Docker           -> $XDG_DATA_HOME or ~/.local/share
 *
 * Getting this wrong on ModelScope means the user silently loses every chat on
 * the next restart, so detection is explicit and the result is reported in the
 * UI rather than assumed.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

function detect() {
  // Termux sets PREFIX to its own tree and ships a recognisable HOME.
  const prefix = process.env.PREFIX || '';
  if (process.platform === 'android' || /com\.termux/.test(prefix) || /com\.termux/.test(os.homedir() || '')) {
    return 'termux';
  }
  // ModelScope Studios mount a persistent volume here and nowhere else.
  if (process.platform === 'linux' && fs.existsSync('/mnt/workspace')) {
    return 'modelscope';
  }
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/** True when the process is almost certainly inside a container. */
function inContainer() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /docker|containerd|kubepods/.test(cg);
  } catch {
    return false;
  }
}

/**
 * Root for everything the manager owns: its own state, the SillyTavern
 * checkout, backups and logs. Overridable with STM_HOME for people who keep
 * their data on another disk.
 */
function resolveHome(kind) {
  if (process.env.STM_HOME) return path.resolve(process.env.STM_HOME);

  switch (kind) {
    case 'modelscope':
      // The one persistent path. Anything else is erased when the Studio sleeps.
      return '/mnt/workspace/sillytavern-manager';
    case 'termux':
      return path.join(process.env.PREFIX ? path.join(process.env.PREFIX, 'var') : os.homedir(), 'sillytavern-manager');
    case 'windows':
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SillyTavernManager');
    case 'macos':
      return path.join(os.homedir(), 'Library', 'Application Support', 'SillyTavernManager');
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'sillytavern-manager');
  }
}

/**
 * Is the home directory actually going to survive a restart?
 * On ModelScope this is the difference between a working product and a
 * data-loss bug, so we probe rather than trust.
 */
function checkDurability(home, kind) {
  if (kind === 'modelscope') {
    const persistent = home.startsWith('/mnt/workspace');
    return {
      durable: persistent,
      reason: persistent
        ? 'Stored on /mnt/workspace, which ModelScope keeps across restarts and sleep.'
        : 'NOT on /mnt/workspace - this Studio erases everything else when it sleeps.',
    };
  }
  if (inContainer()) {
    return {
      durable: false,
      unknown: true,
      reason: 'Running in a container. Data survives only if this path is a mounted volume.',
    };
  }
  return { durable: true, reason: 'Ordinary disk storage.' };
}

const kind = detect();
const home = resolveHome(kind);

const paths = {
  kind,
  container: inContainer(),
  home,
  /** SillyTavern checkout (the app itself). */
  stRoot: path.join(home, 'sillytavern'),
  /** Manager state: settings, credentials, install id, usage records. */
  stateDir: path.join(home, 'state'),
  /** Local backup archives. */
  backupDir: path.join(home, 'backups'),
  /** Rotated log files. */
  logDir: path.join(home, 'logs'),
  /** Downloaded binaries (cloudflared). */
  binDir: path.join(home, 'bin'),
  /** Scratch space for downloads and extraction. */
  tmpDir: path.join(home, 'tmp'),
};

paths.durability = checkDurability(home, kind);

/** Human label for the UI. */
paths.label = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
  termux: 'Android (Termux)',
  modelscope: 'ModelScope Studio',
}[kind] || kind;

function ensureDirs() {
  for (const d of [paths.home, paths.stateDir, paths.backupDir, paths.logDir, paths.binDir, paths.tmpDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { ...paths, ensureDirs, detect, resolveHome, inContainer };
