'use strict';
/**
 * Tests for the parts where a mistake is expensive: the privacy allowlist, zip
 * handling for multi-gigabyte archives, backup profile filtering, and request
 * signing.
 *
 * Run with `npm test`. Set STM_SAMPLE_BACKUP to the path of a real SillyTavern
 * export to also exercise the archive code against genuine data.
 */
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { extractRequestMeta, createUsageScanner, hostOf } = require('../src/core/stats');
const ST = require('../src/core/sillytavern');
const archive = require('../src/core/archive');
const { S3Client } = require('../src/core/s3');
const { Store } = require('../src/core/store');
const { Auth, isLoopback } = require('../src/auth');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

(async () => {
  console.log('\nprivacy');

  await test('generation metadata carries no key, prompt, name or URL path', () => {
    const meta = extractRequestMeta({
      chat_completion_source: 'claude',
      model: 'claude-opus-4-20250514',
      stream: true,
      max_tokens: 800,
      custom_url: 'https://api.anthropic.com/v1/messages?token=SUPERSECRET',
      api_key_claude: 'sk-ant-DO-NOT-LEAK',
      reverse_proxy_password: 'hunter2',
      messages: [{ role: 'user', content: 'private roleplay text' }],
      char_name: 'Alice',
      user_name: 'Bob',
    });
    const s = JSON.stringify(meta);
    for (const secret of ['SUPERSECRET', 'sk-ant', 'hunter2', 'private roleplay', 'Alice', 'Bob', 'v1/messages']) {
      assert.ok(!s.includes(secret), `leaked ${secret}`);
    }
    assert.strictEqual(meta.provider, 'claude');
    assert.strictEqual(meta.model, 'claude-opus-4-20250514');
    assert.strictEqual(meta.endpointHost, 'api.anthropic.com');
  });

  await test('URLs are reduced to hostname, dropping paths and queries', () => {
    assert.strictEqual(hostOf('https://example.com/v1/secret?key=abc'), 'example.com');
    assert.strictEqual(hostOf('http://1.2.3.4:5001/v1'), '1.2.3.4:5001');
    assert.strictEqual(hostOf('not a url at all'), null);
  });

  await test('unknown fields are never copied through', () => {
    const meta = extractRequestMeta({ some_new_field_2027: 'sensitive', model: 'm' });
    assert.ok(!JSON.stringify(meta).includes('sensitive'));
  });

  console.log('\ntoken accounting');

  await test('reads OpenAI-shaped usage', () => {
    const s = createUsageScanner();
    s.push(Buffer.from('{"usage":{"prompt_tokens":900,"completion_tokens":150,"total_tokens":1050}}'));
    assert.deepStrictEqual(s.result(), { promptTokens: 900, completionTokens: 150, totalTokens: 1050 });
  });

  await test('reads Anthropic-shaped usage split across stream chunks', () => {
    const s = createUsageScanner();
    s.push(Buffer.from('data: {"message":{"usage":{"input_tokens":1200,"output_tokens":1}}}\n\n'));
    s.push(Buffer.from('data: {"delta":{"text":"hello"}}\n\n'));
    s.push(Buffer.from('data: {"usage":{"output_tokens":345}}\n\n'));
    const r = s.result();
    assert.strictEqual(r.promptTokens, 1200);
    assert.strictEqual(r.completionTokens, 345);
    assert.strictEqual(r.totalTokens, 1545);
  });

  await test('reads Google-shaped usage', () => {
    const s = createUsageScanner();
    s.push(Buffer.from('{"usageMetadata":{"promptTokenCount":77,"candidatesTokenCount":22,"totalTokenCount":99}}'));
    assert.strictEqual(s.result().totalTokens, 99);
  });

  console.log('\nbackup profiles');

  await test('secrets.json is excluded unless explicitly requested', () => {
    assert.strictEqual(ST.makeFilter('full')('secrets.json'), false);
    assert.strictEqual(ST.makeFilter('full', { includeSecrets: true })('secrets.json'), true);
  });

  await test('rebuildable and duplicated data is always pruned', () => {
    const f = ST.makeFilter('full', { includeSecrets: true });
    for (const junk of [
      'thumbnails/avatar/x.png',
      'vectors/index.bin',
      'backups/chat_2026.jsonl',
      'extensions/Thing/.git/objects/pack/p.pack',
      'extensions/Thing/node_modules/x/index.js',
    ]) assert.strictEqual(f(junk), false, `should have pruned ${junk}`);
    assert.strictEqual(f('characters/Alice.png'), true);
  });

  await test('the chats profile keeps conversations and drops character cards', () => {
    const f = ST.makeFilter('chats');
    assert.strictEqual(f('chats/Alice/2026.jsonl'), true);
    assert.strictEqual(f('worlds/lore.json'), true);
    assert.strictEqual(f('settings.json'), true);
    assert.strictEqual(f('characters/Alice.png'), false);
    assert.strictEqual(f('extensions/Thing/index.js'), false);
  });

  await test('a SillyTavern export is recognised, a random zip is not', () => {
    assert.strictEqual(ST.looksLikeUserBackup(
      ['settings.json', 'characters/A.png', 'chats/', 'worlds/w.json'],
    ).ok, true);
    assert.strictEqual(ST.looksLikeUserBackup(['src/index.js', 'package.json']).ok, false);
  });

  console.log('\narchives');

  const tmp = path.join(os.tmpdir(), `stm-test-${process.pid}`);
  await fsp.mkdir(path.join(tmp, 'src', 'sub'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'src', 'settings.json'), '{"a":1}');
  await fsp.writeFile(path.join(tmp, 'src', 'sub', 'chát ünicode.txt'), 'hello');

  await test('zip round-trips unicode and nested paths', async () => {
    const zip = path.join(tmp, 'out.zip');
    const made = await archive.createZipFromDir(path.join(tmp, 'src'), zip);
    assert.strictEqual(made.files, 2);
    const names = (await archive.listZip(zip)).map((e) => e.name).sort();
    assert.deepStrictEqual(names, ['settings.json', 'sub/chát ünicode.txt']);

    const back = path.join(tmp, 'back');
    await archive.extractZip(zip, back);
    assert.strictEqual(await fsp.readFile(path.join(back, 'sub', 'chát ünicode.txt'), 'utf8'), 'hello');
  });

  await test('zip slip is refused', () => {
    assert.strictEqual(archive.safeJoin(tmp, '../../evil.txt'), null);
    assert.strictEqual(archive.safeJoin(tmp, '/etc/passwd'), null);
    assert.strictEqual(archive.safeJoin(tmp, 'C:/windows/x'), null);
    assert.ok(archive.safeJoin(tmp, 'chats/ok.jsonl'));
  });

  const sample = process.env.STM_SAMPLE_BACKUP;
  if (sample && fs.existsSync(sample)) {
    await test('a real SillyTavern export lists without being read into memory', async () => {
      const before = process.memoryUsage().heapUsed;
      const entries = await archive.listZip(sample);
      const growth = process.memoryUsage().heapUsed - before;
      assert.ok(entries.length > 0);
      assert.ok(ST.looksLikeUserBackup(entries.map((e) => e.name)).ok);
      assert.ok(growth < 200e6, `listing grew the heap by ${(growth / 1e6).toFixed(0)} MB`);
    });
  } else {
    console.log('  skip  real-export check (set STM_SAMPLE_BACKUP to enable)');
  }

  console.log('\nrequest signing');

  await test('SigV4 signing key matches the published AWS vector', () => {
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const key = hmac(hmac(hmac(hmac(
      'AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830'), 'us-east-1'), 'iam'), 'aws4_request');
    assert.strictEqual(key.toString('hex'),
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });

  await test('object keys are escaped without mangling separators', () => {
    const c = new S3Client({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b',
    });
    const signed = c.sign({ method: 'PUT', key: 'sillytavern/stm full.zip', now: new Date('2026-09-09T05:45:00Z') });
    assert.ok(signed.canonicalRequest.includes('/b/sillytavern/stm%20full.zip'));
    assert.ok(signed.headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AK/20260909/auto/s3/'));
  });

  console.log('\nfirst-run ownership');

  const fakeReq = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });

  await test('a genuinely local request counts as local', () => {
    assert.strictEqual(isLoopback(fakeReq('127.0.0.1')), true);
    assert.strictEqual(isLoopback(fakeReq('::1')), true);
  });

  await test('a tunnelled request is NOT local even though it arrives on loopback', () => {
    // cloudflared connects to us over 127.0.0.1, so without this check every
    // request on the internet would look local and could claim the panel.
    assert.strictEqual(isLoopback(fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })), false);
    assert.strictEqual(isLoopback(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), false);
    assert.strictEqual(isLoopback(fakeReq('127.0.0.1', { 'cf-ray': 'abc123' })), false);
    assert.strictEqual(isLoopback(fakeReq('10.0.0.5')), false);
  });

  await test('an unconfigured panel is claimable only locally or with the code', () => {
    const auth = new Auth(new Store(path.join(tmp, 'auth.json')));
    const remote = fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' });
    assert.strictEqual(auth.mayClaim(remote, undefined), false, 'claimed with no code');
    assert.strictEqual(auth.mayClaim(remote, 'DEADBEEF'), false, 'claimed with wrong code');
    assert.strictEqual(auth.mayClaim(remote, auth.setupCode.toLowerCase()), true, 'code should be case-insensitive');
    assert.strictEqual(auth.mayClaim(fakeReq('127.0.0.1'), undefined), true, 'local claim refused');
    auth.setPassword('a-real-password');
    assert.strictEqual(auth.mayClaim(fakeReq('127.0.0.1'), undefined), false, 'still claimable once configured');
  });

  console.log('\nsettings store');

  await test('secrets are redacted before reaching the browser', () => {
    const file = path.join(tmp, 'settings.json');
    const store = new Store(file);
    store.set('adminPasswordHash', 'deadbeef');
    store.set('backup.remote.secretAccessKey', 'super-secret-key');
    store.set('backup.remote.accessKeyId', 'AKIAEXAMPLE');
    const out = JSON.stringify(store.redacted());
    assert.ok(!out.includes('deadbeef'));
    assert.ok(!out.includes('super-secret-key'));
    assert.ok(!out.includes('AKIAEXAMPLE'));
  });

  await test('settings survive a reload', () => {
    const file = path.join(tmp, 'settings2.json');
    const a = new Store(file);
    a.set('sillytavern.port', 8123);
    const id = a.get('installId');
    const b = new Store(file);
    assert.strictEqual(b.get('sillytavern.port'), 8123);
    assert.strictEqual(b.get('installId'), id);
  });

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
