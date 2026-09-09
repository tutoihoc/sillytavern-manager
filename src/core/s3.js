'use strict';
/**
 * Minimal S3 client (AWS Signature V4) for Cloudflare R2 and anything
 * S3-compatible. Hand-rolled so the manager carries no AWS SDK - it has to
 * install cleanly on Android/Termux where native builds are painful.
 *
 * Multipart upload matters here rather than being a nicety: a real SillyTavern
 * backup measured 2.36 GB, and single-PUT uploads cap at 5 GB while also
 * meaning any network blip restarts the whole transfer.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const PART_SIZE = 64 * 1024 * 1024;   // 64 MB: ~37 parts for a 2.4 GB archive

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
const encodeKey = (key) => key.split('/').map(encodeRfc3986).join('/');

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

class S3Client {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, region = 'auto', service = 's3' }) {
    if (!endpoint) throw new Error('S3 endpoint is required');
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    this.region = region;
    this.service = service;
  }

  /** Build signed headers for one request. Exposed so tests can inspect it. */
  sign({ method, key = '', query = '', payloadHash = EMPTY_SHA256, now = new Date(), extraHeaders = {} }) {
    const host = new URL(this.endpoint).host;
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const canonicalUri = key ? `/${this.bucket}/${encodeKey(key)}` : `/${this.bucket}/`;

    const headers = {};
    for (const [k, v] of Object.entries({
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    })) headers[k.toLowerCase()] = String(v).trim();

    const sortedNames = Object.keys(headers).sort();
    const canonicalHeaders = sortedNames.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = sortedNames.join(';');

    const canonicalRequest = [
      method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const signature = crypto
      .createHmac('sha256', signingKey(this.secretAccessKey, dateStamp, this.region, this.service))
      .update(stringToSign).digest('hex');

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { headers, url: `${this.endpoint}${canonicalUri}${query ? '?' + query : ''}`, canonicalRequest };
  }

  async request({ method, key = '', query = '', body = null, extraHeaders = {}, timeoutMs = 300_000 }) {
    const payload = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const { headers, url } = this.sign({
      method, key, query, payloadHash: sha256hex(payload), extraHeaders,
    });
    const res = await fetch(url, {
      method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`S3 ${method} ${key || '/'} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  }

  /** Round-trip check used by the "Test connection" button. */
  async testConnection() {
    await this.request({ method: 'GET', query: 'list-type=2&max-keys=1', timeoutMs: 20_000 });
    return { ok: true };
  }

  put(key, body, contentType = 'application/octet-stream') {
    return this.request({ method: 'PUT', key, body, extraHeaders: { 'content-type': contentType } });
  }

  async get(key) {
    const res = await this.request({ method: 'GET', key });
    return Buffer.from(await res.arrayBuffer());
  }

  /** Stream an object straight to disk, so restores never buffer a GB in RAM. */
  async getToFile(key, destFile, onProgress) {
    const { headers, url } = this.sign({ method: 'GET', key });
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3_600_000) });
    if (!res.ok) throw new Error(`S3 GET ${key} -> ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(destFile);
    let received = 0;
    for await (const chunk of res.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress({ received, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    return { bytes: received };
  }

  delete(key) { return this.request({ method: 'DELETE', key }); }

  async list(prefix = '') {
    const out = [];
    let token = null;
    do {
      let query = `list-type=2&prefix=${encodeRfc3986(prefix)}`;
      if (token) query += `&continuation-token=${encodeRfc3986(token)}`;
      const res = await this.request({ method: 'GET', query });
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = m[1];
        const pick = (tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1];
        out.push({ key: pick('Key'), size: Number(pick('Size') || 0), modified: pick('LastModified') });
      }
      token = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || null;
    } while (token);
    return out;
  }

  // ---- multipart -----------------------------------------------------------

  async createMultipart(key, contentType = 'application/zip') {
    const res = await this.request({
      method: 'POST', key, query: 'uploads', extraHeaders: { 'content-type': contentType },
    });
    const xml = await res.text();
    const id = (xml.match(/<UploadId>([\s\S]*?)<\/UploadId>/) || [])[1];
    if (!id) throw new Error('S3 did not return an UploadId');
    return id;
  }

  async uploadPart(key, uploadId, partNumber, body) {
    const res = await this.request({
      method: 'PUT', key, query: `partNumber=${partNumber}&uploadId=${encodeRfc3986(uploadId)}`, body,
    });
    const etag = res.headers.get('etag');
    if (!etag) throw new Error(`part ${partNumber} returned no ETag`);
    return etag;
  }

  completeMultipart(key, uploadId, parts) {
    const xml = '<CompleteMultipartUpload>'
      + parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')
      + '</CompleteMultipartUpload>';
    return this.request({
      method: 'POST', key, query: `uploadId=${encodeRfc3986(uploadId)}`,
      body: xml, extraHeaders: { 'content-type': 'application/xml' },
    });
  }

  abortMultipart(key, uploadId) {
    return this.request({ method: 'DELETE', key, query: `uploadId=${encodeRfc3986(uploadId)}` })
      .catch(() => {});   // best effort; a stale upload expires on its own
  }

  /**
   * Upload a file, choosing single PUT or multipart by size.
   * A failed multipart is aborted so R2 does not keep charging for orphan parts.
   */
  async uploadFile(key, filePath, { contentType = 'application/zip', onProgress = null } = {}) {
    const { size } = await fsp.stat(filePath);

    if (size <= PART_SIZE) {
      const body = await fsp.readFile(filePath);
      await this.put(key, body, contentType);
      if (onProgress) onProgress({ sent: size, total: size, part: 1, parts: 1 });
      return { key, size, parts: 1 };
    }

    const uploadId = await this.createMultipart(key, contentType);
    const parts = [];
    let sent = 0;
    const totalParts = Math.ceil(size / PART_SIZE);

    try {
      const fh = await fsp.open(filePath, 'r');
      try {
        for (let n = 1; n <= totalParts; n++) {
          const len = Math.min(PART_SIZE, size - (n - 1) * PART_SIZE);
          const buf = Buffer.allocUnsafe(len);
          await fh.read(buf, 0, len, (n - 1) * PART_SIZE);
          const etag = await this.uploadPart(key, uploadId, n, buf);
          parts.push({ n, etag });
          sent += len;
          if (onProgress) onProgress({ sent, total: size, part: n, parts: totalParts });
        }
      } finally {
        await fh.close();
      }
      await this.completeMultipart(key, uploadId, parts);
      return { key, size, parts: totalParts };
    } catch (err) {
      await this.abortMultipart(key, uploadId);
      throw err;
    }
  }
}

module.exports = { S3Client, PART_SIZE, encodeKey, sha256hex };
