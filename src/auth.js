'use strict';
/**
 * Login for the control panel.
 *
 * The panel can sit on a public trycloudflare URL, so it gets its own password
 * independent of SillyTavern's. On first run there is no password: the setup
 * flow asks the user to choose one, and until then the panel is reachable only
 * from loopback so an unconfigured install cannot be hijacked from the internet.
 */
const crypto = require('crypto');

const COOKIE = 'stm_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

class Auth {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();   // token -> expiry
  }

  get configured() {
    return !!this.store.get('adminPasswordHash');
  }

  setPassword(password) {
    if (!password || password.length < 6) {
      throw new Error('Choose a password of at least 6 characters');
    }
    const { hash, salt } = hashPassword(password);
    this.store.set('adminPasswordHash', hash);
    this.store.set('adminPasswordSalt', salt);
    this.sessions.clear();       // old sessions die with the old password
    return true;
  }

  login(password) {
    if (!this.configured) throw new Error('No password has been set yet');
    const ok = verifyPassword(
      password || '',
      this.store.get('adminPasswordHash'),
      this.store.get('adminPasswordSalt'),
    );
    if (!ok) return null;
    return this.issue();
  }

  issue() {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + SESSION_MS);
    this.sweep();
    return token;
  }

  sweep() {
    const now = Date.now();
    for (const [t, exp] of this.sessions) if (exp < now) this.sessions.delete(t);
  }

  tokenFrom(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(new RegExp(`${COOKIE}=([\\w.-]+)`));
    if (m) return m[1];
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7);
    return null;
  }

  /**
   * Is this request allowed to use the panel?
   * Before a password exists, only loopback is trusted - that is what makes
   * first-run setup safe on a machine that is already exposed to a tunnel.
   */
  check(req) {
    if (!this.configured) {
      return isLoopback(req)
        ? { ok: true, reason: 'first-run-loopback' }
        : { ok: false, reason: 'setup-required-loopback-only' };
    }
    const token = this.tokenFrom(req);
    if (!token) return { ok: false, reason: 'no-session' };
    const exp = this.sessions.get(token);
    if (!exp || exp < Date.now()) {
      this.sessions.delete(token);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, token };
  }

  cookieHeader(token) {
    return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
  }

  clearCookieHeader() {
    return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
  }

  logout(req) {
    const token = this.tokenFrom(req);
    if (token) this.sessions.delete(token);
  }
}

module.exports = { Auth, COOKIE, isLoopback, hashPassword, verifyPassword };
