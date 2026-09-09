'use strict';
/**
 * Minimal S3 client (AWS Signature V4) - enough for Cloudflare R2 backups.
 * Hand-rolled so the image carries no AWS SDK. R2 uses region "auto".
 */
const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
// Object keys keep their slashes; each segment is escaped separately.
const encodeKey = (key) => key.split('/').map(encodeRfc3986).join('/');

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

class S3Client {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, region = 'auto', service = 's3' }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    this.region = region;
    this.service = service;
  }

  /** Build the signed headers for one request. Exposed for testing. */
  sign({ method, key, query = '', payload = Buffer.alloc(0), now = new Date(), extraHeaders = {} }) {
    const host = new URL(this.endpoint).host;
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260909T054500Z
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(payload);
    const canonicalUri = `/${this.bucket}/${encodeKey(key)}`.replace(/\/+$/, key ? '' : '/');

    // Canonical headers must be lowercase-keyed, trimmed and sorted by name.
    const headers = {};
    for (const [k, v] of Object.entries({
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    })) headers[k.toLowerCase()] = String(v).trim();

    const sortedNames = Object.keys(headers).sort();
    const canonicalHeaders = sortedNames.map((h) => h + ':' + headers[h] + '\n').join('');
    const signedHeaders = sortedNames.join(';');

    const canonicalRequest = [
      method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', signingKey(this.secretAccessKey, dateStamp, this.region, this.service))
      .update(stringToSign).digest('hex');

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { headers, url: `${this.endpoint}${canonicalUri}${query ? '?' + query : ''}`, canonicalRequest, stringToSign };
  }

  async request({ method, key = '', query = '', payload = Buffer.alloc(0), extraHeaders = {} }) {
    const { headers, url } = this.sign({ method, key, query, payload, extraHeaders });
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : payload,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`S3 ${method} ${key || '/'} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  }

  put(key, body, contentType = 'application/octet-stream') {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return this.request({ method: 'PUT', key, payload, extraHeaders: { 'content-type': contentType } });
  }

  async get(key) {
    const res = await this.request({ method: 'GET', key });
    return Buffer.from(await res.arrayBuffer());
  }

  delete(key) { return this.request({ method: 'DELETE', key }); }

  /** List objects under a prefix (ListObjectsV2). Returns [{key,size,modified}]. */
  async list(prefix = '') {
    const query = `list-type=2&prefix=${encodeRfc3986(prefix)}`;
    const res = await this.request({ method: 'GET', key: '', query });
    const xml = await res.text();
    const out = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const pick = (tag) => (block.match(new RegExp(`<${tag}>([\s\S]*?)</${tag}>`)) || [])[1];
      out.push({
        key: pick('Key'),
        size: parseInt(pick('Size') || '0', 10),
        modified: pick('LastModified'),
      });
    }
    return out;
  }
}

module.exports = { S3Client, encodeKey, sha256hex };
