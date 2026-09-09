'use strict';
/**
 * Durable key/value settings for the manager, written atomically.
 *
 * Small enough to keep in one JSON file. Written via a temp file + rename so a
 * power cut (or a ModelScope Studio being killed mid-write) cannot leave a
 * truncated settings file that bricks the next start.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  installId: null,
  adminPasswordHash: null,
  adminPasswordSalt: null,
  termsAcceptedAt: null,

  sillytavern: {
    installedVersion: null,   // e.g. "1.18.0" or "staging@<sha>"
    installedAt: null,
    layout: null,             // "data" (>=1.12) or "public" (legacy)
    port: 8000,
    autoStart: true,
  },

  tunnel: {
    enabled: true,
    provider: 'cloudflare-quick',
    lastUrl: null,
    webhookUrl: '',
  },

  backup: {
    profile: 'essential',     // "essential" | "full"
    includeSecrets: false,    // secrets.json holds API keys - off for remote
    intervalMinutes: 60,
    keepLocal: 5,
    onShutdown: true,
    remote: {
      enabled: false,
      endpoint: '',
      bucket: '',
      region: 'auto',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: 'sillytavern',
      keepRemote: 3,
    },
  },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && !Array.isArray(base?.[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = deepMerge(DEFAULTS, this._read());
    if (!this.data.installId) {
      this.data.installId = crypto.randomUUID();
      this.save();
    }
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // atomic on the same filesystem
  }

  get(dotted, fallback = undefined) {
    const v = dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
    return v === undefined ? fallback : v;
  }

  set(dotted, value) {
    const keys = dotted.split('.');
    const last = keys.pop();
    let node = this.data;
    for (const k of keys) {
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[last] = value;
    this.save();
    return value;
  }

  merge(dotted, patch) {
    const cur = this.get(dotted) || {};
    return this.set(dotted, deepMerge(cur, patch));
  }

  /** Everything except things that must never reach the browser. */
  redacted() {
    const c = JSON.parse(JSON.stringify(this.data));
    delete c.adminPasswordHash;
    delete c.adminPasswordSalt;
    if (c.backup?.remote) {
      c.backup.remote.secretAccessKey = c.backup.remote.secretAccessKey ? '********' : '';
      c.backup.remote.accessKeyId = c.backup.remote.accessKeyId
        ? c.backup.remote.accessKeyId.slice(0, 4) + '****'
        : '';
    }
    return c;
  }
}

module.exports = { Store, DEFAULTS, deepMerge };
