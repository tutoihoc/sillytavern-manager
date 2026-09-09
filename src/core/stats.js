'use strict';
/**
 * Local usage records: what was generated, with which provider and model, and
 * how many tokens it cost. Kept on disk as JSONL so the file can be appended
 * cheaply, truncated safely, and read back for the charts.
 *
 * Extraction rules, applied to the request body and a light scan of the
 * response stream:
 *   - the request tells us provider, model, streaming flag and token budget
 *   - the response tells us actual token usage, when the provider reports it
 * Nothing else is read, and the response scan never blocks the pipe: it watches
 * chunks as they fly past and keeps only the numbers.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const PROVIDER_KEYS = ['chat_completion_source', 'api_type', 'api_server_type'];
const MODEL_KEYS = ['model', 'chat_completion_model'];
const URL_KEYS = ['custom_url', 'api_server', 'reverse_proxy', 'server_urls'];

const MAX_RECORDS = 20000;

function hostOf(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;   // host only, never the path
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

/** Allowlisted metadata from a /generate request body. */
function extractRequestMeta(body) {
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
    endpointHost,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    maxTokens: Number.isFinite(body.max_tokens) ? body.max_tokens : null,
  };
}

/**
 * Watch a response stream for token counts without buffering or delaying it.
 * Handles the shapes used by OpenAI-style, Anthropic-style and Google-style
 * responses.
 */
function createUsageScanner() {
  const found = { promptTokens: null, completionTokens: null, totalTokens: null };
  const patterns = [
    [/"prompt_tokens"\s*:\s*(\d+)/g, 'promptTokens'],
    [/"input_tokens"\s*:\s*(\d+)/g, 'promptTokens'],
    [/"promptTokenCount"\s*:\s*(\d+)/g, 'promptTokens'],
    [/"completion_tokens"\s*:\s*(\d+)/g, 'completionTokens'],
    [/"output_tokens"\s*:\s*(\d+)/g, 'completionTokens'],
    [/"candidatesTokenCount"\s*:\s*(\d+)/g, 'completionTokens'],
    [/"total_tokens"\s*:\s*(\d+)/g, 'totalTokens'],
    [/"totalTokenCount"\s*:\s*(\d+)/g, 'totalTokens'],
  ];
  let scanned = 0;
  const LIMIT = 4 * 1024 * 1024;   // stop scanning very long responses

  return {
    push(chunk) {
      if (scanned > LIMIT) return;
      scanned += chunk.length;
      const text = chunk.toString('utf8');
      for (const [re, field] of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const n = Number(m[1]);
          if (Number.isFinite(n)) found[field] = n;   // last value wins
        }
      }
    },
    result() {
      const r = { ...found };
      if (r.totalTokens == null && (r.promptTokens != null || r.completionTokens != null)) {
        r.totalTokens = (r.promptTokens || 0) + (r.completionTokens || 0);
      }
      return r;
    },
  };
}

class Stats {
  constructor({ stateDir, log }) {
    this.file = path.join(stateDir, 'usage.jsonl');
    this.log = log;
    this.records = [];
    this.loaded = false;
    this.pending = [];
    this.flushTimer = null;
  }

  async load() {
    if (this.loaded) return;
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      this.records = text.split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      this.records = [];
    }
    this.loaded = true;
  }

  record(entry) {
    const rec = {
      ts: Date.now(),
      provider: entry.provider || 'unknown',
      model: entry.model || 'unknown',
      endpointHost: entry.endpointHost || null,
      stream: entry.stream ?? null,
      maxTokens: entry.maxTokens ?? null,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      totalTokens: entry.totalTokens ?? null,
      status: entry.status ?? null,
      durationMs: entry.durationMs ?? null,
      ok: entry.status ? entry.status >= 200 && entry.status < 400 : null,
    };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.pending.push(rec);
    this._scheduleFlush();
    return rec;
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 2000);
    this.flushTimer.unref?.();
  }

  async flush() {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.appendFile(this.file, batch.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch (err) {
      this.log.warn(`Could not write usage log: ${err.message}`);
    }
  }

  /** Aggregates for the dashboard charts. */
  summary({ days = 30 } = {}) {
    const since = Date.now() - days * 86400_000;
    const rows = this.records.filter((r) => r.ts >= since);

    const byDay = new Map();
    const byModel = new Map();
    const byProvider = new Map();
    let tokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let errors = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const r of rows) {
      const day = new Date(r.ts).toISOString().slice(0, 10);
      const d = byDay.get(day) || { day, requests: 0, tokens: 0 };
      d.requests++;
      d.tokens += r.totalTokens || 0;
      byDay.set(day, d);

      const mKey = `${r.provider}|${r.model}`;
      const m = byModel.get(mKey) || { provider: r.provider, model: r.model, requests: 0, tokens: 0 };
      m.requests++;
      m.tokens += r.totalTokens || 0;
      byModel.set(mKey, m);

      const p = byProvider.get(r.provider) || { provider: r.provider, requests: 0, tokens: 0 };
      p.requests++;
      p.tokens += r.totalTokens || 0;
      byProvider.set(r.provider, p);

      tokens += r.totalTokens || 0;
      promptTokens += r.promptTokens || 0;
      completionTokens += r.completionTokens || 0;
      if (r.ok === false) errors++;
      if (r.durationMs) { durationSum += r.durationMs; durationCount++; }
    }

    // Fill empty days so the chart has a continuous axis.
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      series.push(byDay.get(day) || { day, requests: 0, tokens: 0 });
    }

    return {
      totals: {
        requests: rows.length,
        tokens,
        promptTokens,
        completionTokens,
        errors,
        avgDurationMs: durationCount ? Math.round(durationSum / durationCount) : null,
        since: new Date(since).toISOString(),
      },
      series,
      byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests).slice(0, 25),
      byProvider: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
      recent: this.records.slice(-25).reverse(),
    };
  }

  async reset() {
    this.records = [];
    this.pending = [];
    await fsp.rm(this.file, { force: true }).catch(() => {});
  }
}

module.exports = { Stats, extractRequestMeta, createUsageScanner, hostOf };
