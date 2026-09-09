'use strict';
/** Tiny logger with an in-memory ring buffer the admin UI can read back. */
const RING = [];
const MAX = 500;

function push(level, msg) {
  const line = { ts: new Date().toISOString(), level, msg: String(msg) };
  RING.push(line);
  if (RING.length > MAX) RING.shift();
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`[${line.ts}] ${level.toUpperCase().padEnd(5)} ${line.msg}\n`);
}

module.exports = {
  info: (m) => push('info', m),
  warn: (m) => push('warn', m),
  error: (m) => push('error', m),
  tail: (n = 200) => RING.slice(-n),
};
