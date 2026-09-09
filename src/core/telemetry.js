'use strict';
/**
 * Usage reporting to the project's own server.
 *
 * This build reports usage. That is the deal for a free tool, and the terms
 * screen on first run says so in three lines rather than three pages.
 *
 * The contract with the collection server is defined here so the server can be
 * written against it later:
 *
 *   POST  {endpoint}/v1/events
 *   Headers: content-type: application/json
 *            x-stm-install: <install uuid>
 *            x-stm-version: <manager version>
 *   Body:  { schema, installId, app, platform, sentAt, events: [ ... ] }
 *   Reply: 2xx = accepted. Anything else and the batch is dropped; reporting
 *          never blocks or slows the user.
 *
 *   POST  {endpoint}/v1/install     once, on first run
 *   Body:  { schema, installId, app, platform, firstSeenAt }
 *
 * WHAT IS SENT - a fixed allowlist, built field by field. Nothing is ever
 * copied wholesale from a request, so a new SillyTavern field cannot start
 * leaking by accident:
 *   install id, manager version, OS/platform kind, provider, model,
 *   endpoint HOSTNAME, streaming flag, token counts, status code, duration.
 *
 * WHAT IS NEVER SENT: API keys, prompts, messages, completions, character
 * cards, personas, lorebooks, world info, file names, URL paths or query
 * strings, IP addresses, account names, or any request/response body.
 */
const os = require('os');

const DEFAULT_ENDPOINT = process.env.STM_TELEMETRY_ENDPOINT || 'https://telemetry.invalid/stm';
const SCHEMA_VERSION = 1;
const FLUSH_MS = 5 * 60_000;
const MAX_QUEUE = 1000;
const MAX_BATCH = 200;

class Telemetry {
  constructor({ store, logs, version, endpoint = DEFAULT_ENDPOINT, platform }) {
    this.store = store;
    this.log = logs.logger('manager');
    this.version = version;
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.platform = platform;

    this.queue = [];
    this.sent = [];          // recent flush outcomes, shown in the UI
    this.timer = null;
    this.configured = !/telemetry\.invalid/.test(this.endpoint);
  }

  get installId() {
    return this.store.get('installId');
  }

  /** Identity block repeated on every payload. */
  identity() {
    return {
      installId: this.installId,
      app: { name: 'sillytavern-manager', version: this.version },
      platform: {
        kind: this.platform.kind,        // windows | linux | termux | modelscope | macos
        container: this.platform.container,
        os: process.platform,
        arch: process.arch,
        node: process.versions.node,
      },
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), FLUSH_MS);
    this.timer.unref?.();
    if (!this.store.get('installReported')) this.reportInstall().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reportInstall() {
    if (!this.configured) return;
    try {
      await this._post('/v1/install', {
        schema: SCHEMA_VERSION,
        ...this.identity(),
        firstSeenAt: new Date().toISOString(),
      });
      this.store.set('installReported', true);
    } catch { /* try again next start */ }
  }

  /**
   * Queue one generation. `usage` is already-allowlisted metadata from stats.js
   * - this method deliberately names every field it copies.
   */
  record(usage) {
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({
      ts: new Date(usage.ts || Date.now()).toISOString(),
      provider: usage.provider ?? null,
      model: usage.model ?? null,
      endpointHost: usage.endpointHost ?? null,
      stream: usage.stream ?? null,
      maxTokens: usage.maxTokens ?? null,
      promptTokens: usage.promptTokens ?? null,
      completionTokens: usage.completionTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      status: usage.status ?? null,
      durationMs: usage.durationMs ?? null,
    });
  }

  /** Exactly what the next flush would transmit - rendered verbatim in the UI. */
  preview() {
    return {
      endpoint: this.configured ? `${this.endpoint}/v1/events` : null,
      configured: this.configured,
      queued: this.queue.length,
      payload: {
        schema: SCHEMA_VERSION,
        ...this.identity(),
        sentAt: new Date().toISOString(),
        events: this.queue.slice(0, 10),
      },
    };
  }

  async _post(pathname, body) {
    const res = await fetch(this.endpoint + pathname, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-stm-install': String(this.installId || ''),
        'x-stm-version': String(this.version),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  async flush() {
    if (!this.queue.length) return { sent: 0 };
    if (!this.configured) {
      // No server wired up yet. Keep the newest events and stop growing.
      if (this.queue.length > MAX_BATCH) this.queue.splice(0, this.queue.length - MAX_BATCH);
      return { sent: 0, pending: this.queue.length, reason: 'no endpoint configured' };
    }

    const batch = this.queue.splice(0, MAX_BATCH);
    try {
      await this._post('/v1/events', {
        schema: SCHEMA_VERSION,
        ...this.identity(),
        sentAt: new Date().toISOString(),
        events: batch,
      });
      this._note({ ok: true, count: batch.length });
      return { sent: batch.length };
    } catch (err) {
      // Reporting must never degrade the product. Drop the batch and move on.
      this._note({ ok: false, count: batch.length, error: err.message });
      return { sent: 0, error: err.message };
    }
  }

  _note(entry) {
    this.sent.push({ at: new Date().toISOString(), ...entry });
    if (this.sent.length > 20) this.sent.shift();
  }

  status() {
    return {
      configured: this.configured,
      endpoint: this.configured ? this.endpoint : null,
      queued: this.queue.length,
      recent: this.sent.slice(-5),
    };
  }
}

/** Short, readable terms shown once on first run. */
const TERMS = {
  version: 1,
  summary: 'SillyTavern Manager is free. In exchange it reports anonymous usage statistics.',
  points: [
    'Sent: an anonymous install ID, your platform, and for each generation the provider, model, token counts, status and duration.',
    'Never sent: API keys, prompts, chat logs, model output, character cards, or anything identifying you.',
    'You can see the exact data queued for sending at any time under Usage.',
  ],
};

module.exports = { Telemetry, TERMS, SCHEMA_VERSION, DEFAULT_ENDPOINT };
