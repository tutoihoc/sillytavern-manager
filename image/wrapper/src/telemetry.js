'use strict';
/**
 * Usage metering for the wrapper.
 *
 * DESIGN RULE - allowlist, never blocklist.
 * We build the outgoing event by explicitly naming the handful of fields we
 * want. Nothing is copied wholesale from the request body, so a new upstream
 * field can never leak by accident.
 *
 * COLLECTED : provider id, model name, endpoint HOSTNAME, streaming flag,
 *             declared token budget, response status, duration, install id.
 * NEVER COLLECTED : API keys, prompts, messages, completions, character
 *             cards, personas, lorebooks, usernames, URL paths or query
 *             strings (host only), request or response bodies.
 */
const crypto = require('crypto');
const { URL } = require('url');

// Fields that identify WHICH provider/model, in ST's two generate endpoints.
const PROVIDER_KEYS = ['chat_completion_source', 'api_type', 'api_server_type'];
const MODEL_KEYS = ['model', 'chat_completion_model'];
const URL_KEYS = ['custom_url', 'api_server', 'reverse_proxy', 'server_urls'];

function hostOf(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    // Hostname + port only. Paths and query strings can carry tokens.
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

/** Extract only the allowlisted metadata from a parsed generate body. */
function extractMeta(body) {
  if (!body || typeof body !== 'object') return {};
  let endpointHost = null;
  for (const k of URL_KEYS) {
    const v = body[k];
    const h = hostOf(Array.isArray(v) ? v[0] : v);
    if (h) { endpointHost = h; break; }
  }
  return {
    provider: firstString(body, PROVIDER_KEYS),
    model: firstString(body, MODEL_KEYS),
    endpoint_host: endpointHost,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : null,
  };
}

class Telemetry {
  constructor(cfg, state, logger) {
    this.cfg = cfg;
    this.state = state;
    this.log = logger;
    this.queue = [];
    this.sent = [];          // mirror of what actually left the box, for the UI
    this.counters = Object.create(null);
    this.timer = null;
  }

  get enabled() {
    // Consent is stored locally and is the final word.
    return this.cfg.telemetryEnabled
      && this.state.get('telemetryConsent') !== false
      && !!this.cfg.telemetryEndpoint;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), this.cfg.telemetryFlushMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Record one generation call. `meta` must already be allowlisted. */
  record(meta, outcome) {
    const key = `${meta.provider || 'unknown'}|${meta.model || 'unknown'}`;
    this.counters[key] = (this.counters[key] || 0) + 1;

    if (!this.enabled) return;
    if (this.queue.length >= this.cfg.telemetryMaxBuffer) this.queue.shift();

    this.queue.push({
      install_id: this.state.get('installId'),
      ts: new Date().toISOString(),
      provider: meta.provider,
      model: meta.model,
      endpoint_host: meta.endpoint_host,
      stream: meta.stream,
      max_tokens: meta.max_tokens,
      status: outcome.status ?? null,
      duration_ms: outcome.durationMs ?? null,
      ok: outcome.ok ?? null,
    });
  }

  /** Exactly what a flush would send right now - shown verbatim in the UI. */
  preview() {
    return { endpoint: this.cfg.telemetryEndpoint || null, events: this.queue.slice(0, 50) };
  }

  async flush() {
    if (!this.enabled || this.queue.length === 0) return { sent: 0 };
    const batch = this.queue.splice(0, this.cfg.telemetryMaxBuffer);
    const payload = JSON.stringify({
      schema: 1,
      install_id: this.state.get('installId'),
      events: batch,
    });

    try {
      const res = await fetch(this.cfg.telemetryEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.telemetryKey ? { authorization: `Bearer ${this.cfg.telemetryKey}` } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.sent.push({ ts: new Date().toISOString(), count: batch.length, ok: true });
      if (this.sent.length > 50) this.sent.shift();
      return { sent: batch.length };
    } catch (err) {
      // Never let metering failures affect the user. Drop the batch.
      this.log.warn(`telemetry flush failed (${err.message}); dropped ${batch.length} event(s)`);
      this.sent.push({ ts: new Date().toISOString(), count: batch.length, ok: false, error: err.message });
      if (this.sent.length > 50) this.sent.shift();
      return { sent: 0, error: err.message };
    }
  }

  summary() {
    const rows = Object.entries(this.counters).map(([k, count]) => {
      const [provider, model] = k.split('|');
      return { provider, model, count };
    });
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }
}

function newInstallId() {
  return crypto.randomUUID();
}

module.exports = { Telemetry, extractMeta, hostOf, newInstallId };
