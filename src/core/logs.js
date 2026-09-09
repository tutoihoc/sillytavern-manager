'use strict';
/**
 * Log capture for the UI.
 *
 * The whole point of this feature is that a user on an iPhone, or inside a
 * ModelScope Studio with no shell, can still read what SillyTavern printed -
 * including the codes and URLs SillyTavern emits at startup. So logs are:
 *
 *   - kept per source (manager / sillytavern / cloudflared / installer)
 *   - kept in memory for instant tailing, and appended to a rotating file
 *   - handed out with monotonic ids so the UI can poll for "everything after N"
 *     instead of re-fetching the whole buffer
 *
 * Polling, not EventSource: a GET text/event-stream is buffered by Cloudflare
 * quick tunnels, so a live log view built on EventSource would appear frozen
 * for remote users. (Measured; see docs/research/FINDINGS.md.)
 */
const fs = require('fs');
const path = require('path');

const MAX_MEMORY_LINES = 3000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Strip ANSI colour codes and terminal title sequences; SillyTavern emits both
// and they turn into mojibake in a browser.
const ANSI = /\[[0-9;?]*[A-Za-z]|\][^]*(?:|\\)/g;

class LogHub {
  constructor(logDir) {
    this.logDir = logDir;
    this.lines = [];
    this.nextId = 1;
    this.streams = new Map();
    this.listeners = new Set();
  }

  _stream(source) {
    if (!this.logDir) return null;
    if (this.streams.has(source)) return this.streams.get(source);
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const file = path.join(this.logDir, `${source}.log`);
      this._rotate(file);
      const s = fs.createWriteStream(file, { flags: 'a' });
      s.on('error', () => {});
      this.streams.set(source, s);
      return s;
    } catch {
      return null;
    }
  }

  _rotate(file) {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
  }

  /** Record one line. `level` is info | warn | error. */
  push(source, level, message) {
    const text = String(message).replace(ANSI, '').replace(/\r/g, '').trimEnd();
    if (!text) return;
    const entry = { id: this.nextId++, ts: Date.now(), source, level, text };

    this.lines.push(entry);
    if (this.lines.length > MAX_MEMORY_LINES) this.lines.splice(0, this.lines.length - MAX_MEMORY_LINES);

    const s = this._stream(source);
    if (s) s.write(`${new Date(entry.ts).toISOString()} ${level.toUpperCase()} ${text}\n`);

    // Mirror the manager's own lines to the console so a terminal user sees them.
    if (source === 'manager') {
      const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      out.write(`${level === 'info' ? '' : level.toUpperCase() + ' '}${text}\n`);
    }

    for (const fn of this.listeners) {
      try { fn(entry); } catch { /* listener problems are not our problem */ }
    }
  }

  /** Split a chunk of child-process output into lines and record each. */
  pushChunk(source, level, chunk) {
    for (const line of String(chunk).split('\n')) this.push(source, level, line);
  }

  /**
   * Lines after `sinceId`, optionally filtered.
   * Returns { lines, lastId } so the caller can poll incrementally.
   */
  tail({ sinceId = 0, source = null, level = null, search = null, limit = 500 } = {}) {
    let out = this.lines;
    if (sinceId) out = out.filter((l) => l.id > sinceId);
    if (source && source !== 'all') out = out.filter((l) => l.source === source);
    if (level && level !== 'all') {
      out = level === 'error'
        ? out.filter((l) => l.level === 'error')
        : out.filter((l) => l.level === level);
    }
    if (search) {
      const needle = search.toLowerCase();
      out = out.filter((l) => l.text.toLowerCase().includes(needle));
    }
    const clipped = out.slice(-limit);
    return {
      lines: clipped,
      lastId: this.lines.length ? this.lines[this.lines.length - 1].id : 0,
      total: out.length,
    };
  }

  sources() {
    return [...new Set(this.lines.map((l) => l.source))];
  }

  /** Whole buffer as plain text, for the "download logs" button. */
  asText(source = null) {
    return this.lines
      .filter((l) => !source || source === 'all' || l.source === source)
      .map((l) => `${new Date(l.ts).toISOString()} [${l.source}] ${l.level.toUpperCase()} ${l.text}`)
      .join('\n');
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  logger(source) {
    return {
      info: (m) => this.push(source, 'info', m),
      warn: (m) => this.push(source, 'warn', m),
      error: (m) => this.push(source, 'error', m),
    };
  }
}

module.exports = { LogHub };
