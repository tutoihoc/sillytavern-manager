'use strict';
/**
 * Visual editing of SillyTavern's config.yaml.
 *
 * Edits go through yaml's Document API rather than parse-then-restringify, so
 * the user's own comments and key order survive a round trip. People keep notes
 * in that file; silently eating them would be rude and confusing.
 *
 * The schema below drives the UI: the browser renders whatever fields are
 * listed here, so adding a setting is a one-line change in one place.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const YAML = require('yaml');

/**
 * Fields surfaced as friendly controls. Everything else stays editable through
 * the raw YAML tab.
 */
const SCHEMA = [
  {
    group: 'Access',
    blurb: 'Who can reach SillyTavern. The manager already sits in front of it, so these control SillyTavern’s own door. (Listening is managed for you and is not shown here.)',
    fields: [
      { key: 'basicAuthMode', type: 'boolean', label: 'Require a browser password (basic auth)', default: false,
        help: 'A username/password prompt before SillyTavern loads. Simple and effective for a public tunnel.' },
      { key: 'basicAuthUser.username', type: 'string', label: 'Basic auth username', default: 'user',
        showWhen: 'basicAuthMode' },
      { key: 'basicAuthUser.password', type: 'password', label: 'Basic auth password', default: '',
        showWhen: 'basicAuthMode' },
      { key: 'enableUserAccounts', type: 'boolean', label: 'Enable user accounts', default: false,
        help: 'SillyTavern’s own multi-user login, with separate data per account.' },
      { key: 'enableDiscreetLogin', type: 'boolean', label: 'Hide the user list on the login screen', default: false,
        showWhen: 'enableUserAccounts' },
    ],
  },
  {
    group: 'Network',
    blurb: 'Ports and proxying.',
    fields: [
      { key: 'port', type: 'number', label: 'SillyTavern port', default: 8000,
        help: 'Internal only. The manager proxies to it; change it if something else already uses this port.' },
      { key: 'whitelistMode', type: 'boolean', label: 'IP whitelist', default: true,
        help: 'Filters by client IP. Behind the manager every request already looks like 127.0.0.1, so this neither helps nor hurts.' },
      { key: 'hostWhitelist.enabled', type: 'boolean', label: 'Host header whitelist', default: false,
        help: 'Leave off. The manager presents a loopback Host to SillyTavern, so this would only ever lock you out.' },
      { key: 'requestProxy.enabled', type: 'boolean', label: 'Send outgoing API calls through a proxy', default: false },
      { key: 'requestProxy.url', type: 'string', label: 'Proxy URL', default: '',
        placeholder: 'socks5://127.0.0.1:1080', showWhen: 'requestProxy.enabled' },
    ],
  },
  {
    group: 'Behaviour',
    fields: [
      { key: 'autorun', type: 'boolean', label: 'Open a browser on start', default: false,
        help: 'Pointless on a server or phone; the manager keeps it off.' },
      { key: 'enableServerPlugins', type: 'boolean', label: 'Enable server plugins', default: false,
        help: 'Server plugins run arbitrary code inside the SillyTavern process. Only turn on for plugins you trust.' },
      { key: 'disableThumbnails', type: 'boolean', label: 'Disable thumbnail generation', default: false,
        help: 'Saves disk and CPU on weak devices such as a phone, at the cost of slower character lists.' },
      { key: 'allowKeysExposure', type: 'boolean', label: 'Allow API keys to be shown in the UI', default: false },
    ],
  },
];

function flatKeys() {
  return SCHEMA.flatMap((g) => g.fields.map((f) => f.key));
}

class ConfigEditor {
  constructor({ stRoot, log }) {
    this.stRoot = stRoot;
    this.log = log;
  }

  get file() {
    return path.join(this.stRoot, 'config.yaml');
  }

  get defaultFile() {
    return path.join(this.stRoot, 'default', 'config.yaml');
  }

  exists() {
    return fs.existsSync(this.file);
  }

  /**
   * Read the live config, falling back to the shipped default so the editor is
   * usable immediately after install and before SillyTavern's first run.
   */
  async readDocument() {
    let text = null;
    let source = 'config.yaml';
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch {
      try {
        text = await fsp.readFile(this.defaultFile, 'utf8');
        source = 'default/config.yaml';
      } catch {
        text = '';
        source = 'empty';
      }
    }
    return { doc: YAML.parseDocument(text || ''), text, source };
  }

  /** Current values for the schema fields, plus the raw text. */
  async read() {
    const { doc, text, source } = await this.readDocument();
    const values = {};
    for (const key of flatKeys()) {
      const v = doc.getIn(key.split('.'));
      values[key] = v === undefined ? null : (v && typeof v.toJSON === 'function' ? v.toJSON() : v);
    }
    return { schema: SCHEMA, values, raw: text, source, path: this.file };
  }

  /**
   * Apply a patch of schema fields. Comments and unrelated keys are preserved
   * because we mutate the parsed document rather than rewriting the file.
   */
  async patch(changes) {
    const allowed = new Set(flatKeys());
    const { doc } = await this.readDocument();
    const applied = {};

    for (const [key, raw] of Object.entries(changes || {})) {
      if (!allowed.has(key)) continue;
      const field = SCHEMA.flatMap((g) => g.fields).find((f) => f.key === key);
      let value = raw;
      if (field.type === 'boolean') value = raw === true || raw === 'true';
      if (field.type === 'number') {
        value = Number(raw);
        if (!Number.isFinite(value)) continue;
      }
      doc.setIn(key.split('.'), value);
      applied[key] = field.type === 'password' && value ? '********' : value;
    }

    await this.write(String(doc));
    this.log.info(`Updated config.yaml: ${Object.keys(applied).join(', ') || '(nothing)'}`);
    return { applied, restartRequired: true };
  }

  /** Replace the whole file, after checking it parses. */
  async writeRaw(text) {
    const doc = YAML.parseDocument(text);
    if (doc.errors && doc.errors.length) {
      throw new Error(`YAML is not valid: ${doc.errors[0].message}`);
    }
    await this.write(text);
    this.log.info('config.yaml replaced from the raw editor');
    return { ok: true, restartRequired: true };
  }

  /** Atomic write plus a one-deep backup, so a bad edit is recoverable. */
  async write(text) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      await fsp.copyFile(this.file, `${this.file}.bak`).catch(() => {});
    }
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  async restoreBackup() {
    const bak = `${this.file}.bak`;
    if (!fs.existsSync(bak)) throw new Error('there is no previous config.yaml to restore');
    await fsp.copyFile(bak, this.file);
    this.log.info('config.yaml restored from the previous version');
    return { ok: true, restartRequired: true };
  }
}

module.exports = { ConfigEditor, SCHEMA };
