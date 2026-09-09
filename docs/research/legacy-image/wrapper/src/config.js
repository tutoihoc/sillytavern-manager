'use strict';
const path = require('path').posix;

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// /mnt/workspace is the ModelScope Studio persistent volume. It exists only at
// RUNTIME - it is not mounted during `docker build`.
const PERSIST_ROOT = process.env.PERSIST_ROOT || '/mnt/workspace/sillytavern';

const config = {
  // --- ports -------------------------------------------------------------
  // ModelScope Studios only ever expose 7860. Everything else stays on loopback.
  publicPort: int(process.env.PUBLIC_PORT, 7860),
  stPort: int(process.env.ST_PORT, 8000),
  stHost: '127.0.0.1',

  // --- persistence -------------------------------------------------------
  persistRoot: PERSIST_ROOT,
  dataDir: path.join(PERSIST_ROOT, 'data'),
  configDir: path.join(PERSIST_ROOT, 'config'),
  pluginsDir: path.join(PERSIST_ROOT, 'plugins'),
  extensionsDir: path.join(PERSIST_ROOT, 'extensions'),
  stateDir: path.join(PERSIST_ROOT, '_wrapper'),
  backupDir: path.join(PERSIST_ROOT, '_backups'),

  // Baked into the image at build time; copied to persistRoot on first boot.
  seedDir: process.env.SEED_DIR || '/opt/st-seed',
  stAppDir: process.env.ST_APP_DIR || '/home/node/app',

  // --- admin -------------------------------------------------------------
  adminPrefix: '/_admin',
  // If unset, a password is generated on first boot and printed to the logs.
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // --- tunnel ------------------------------------------------------------
  tunnelEnabled: bool(process.env.TUNNEL_ENABLED, true),
  tunnelBin: process.env.CLOUDFLARED_BIN || 'cloudflared',
  // Where to announce a freshly-minted quick-tunnel URL. A Discord/Slack
  // webhook works well: the Studio sleeps, and the URL changes on every wake.
  tunnelWebhook: process.env.TUNNEL_WEBHOOK_URL || '',

  // --- telemetry ---------------------------------------------------------
  telemetryEndpoint: process.env.TELEMETRY_ENDPOINT || '',
  telemetryKey: process.env.TELEMETRY_KEY || '',
  telemetryEnabled: bool(process.env.TELEMETRY_ENABLED, true),
  telemetryFlushMs: int(process.env.TELEMETRY_FLUSH_MS, 60_000),
  telemetryMaxBuffer: int(process.env.TELEMETRY_MAX_BUFFER, 500),

  // --- R2 / S3 backup ----------------------------------------------------
  r2: {
    enabled: bool(process.env.R2_ENABLED, false),
    endpoint: process.env.R2_ENDPOINT || '',       // https://<acct>.r2.cloudflarestorage.com
    bucket: process.env.R2_BUCKET || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    prefix: process.env.R2_PREFIX || 'sillytavern',
    intervalMin: int(process.env.R2_INTERVAL_MIN, 30),
    keep: int(process.env.R2_KEEP, 10),
  },

  // Largest request body we will buffer in order to read its metadata.
  maxTelemetryBodyBytes: int(process.env.MAX_TELEMETRY_BODY, 32 * 1024 * 1024),
};

module.exports = config;
