'use strict';
/**
 * Fetching and installing SillyTavern from its official GitHub repository.
 *
 * We install from the release *zipball* rather than `git clone`, because git is
 * not guaranteed on Windows or a bare Termux install, while zip extraction is
 * already available to us (pure-JS yauzl). That keeps "one click" honest on
 * every target platform.
 *
 * npm, on the other hand, is guaranteed: the manager itself runs on Node.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { extractZip } = require('./archive');
const ST = require('./sillytavern');

const REPO = 'SillyTavern/SillyTavern';
const API = `https://api.github.com/repos/${REPO}`;
const UA = { 'user-agent': 'sillytavern-manager', accept: 'application/vnd.github+json' };

async function ghJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url.replace(API, '')}`);
  return res.json();
}

/**
 * Versions offered in the setup dropdown: tagged releases newest-first, plus
 * the two rolling branches. "latest" is the default and resolves to whatever
 * the newest non-prerelease is at install time.
 */
async function listVersions() {
  const releases = await ghJson(`${API}/releases?per_page=30`);
  const tags = releases
    .filter((r) => !r.draft)
    .map((r) => ({
      id: r.tag_name,
      kind: 'release',
      label: r.tag_name + (r.prerelease ? ' (pre-release)' : ''),
      prerelease: !!r.prerelease,
      publishedAt: r.published_at,
      notesUrl: r.html_url,
    }));

  const newestStable = tags.find((t) => !t.prerelease);

  return {
    options: [
      {
        id: 'latest',
        kind: 'alias',
        label: `Latest release${newestStable ? ` (${newestStable.id})` : ''}`,
        recommended: true,
        resolvesTo: newestStable ? newestStable.id : null,
      },
      ...tags,
      { id: 'release', kind: 'branch', label: 'release branch (rolling stable)' },
      { id: 'staging', kind: 'branch', label: 'staging branch (bleeding edge)' },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

/** Turn a dropdown selection into a concrete zip URL + resolved label. */
async function resolveDownload(selection) {
  if (!selection || selection === 'latest') {
    const rel = await ghJson(`${API}/releases/latest`);
    return {
      version: rel.tag_name,
      kind: 'release',
      url: `https://github.com/${REPO}/archive/refs/tags/${encodeURIComponent(rel.tag_name)}.zip`,
    };
  }
  if (selection === 'staging' || selection === 'release') {
    return {
      version: selection,
      kind: 'branch',
      url: `https://github.com/${REPO}/archive/refs/heads/${selection}.zip`,
    };
  }
  return {
    version: selection,
    kind: 'release',
    url: `https://github.com/${REPO}/archive/refs/tags/${encodeURIComponent(selection)}.zip`,
  };
}

/** Stream a URL to disk, reporting progress when the server sends a length. */
async function download(url, destFile, onProgress) {
  const res = await fetch(url, { headers: { 'user-agent': 'sillytavern-manager' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(destFile), { recursive: true });

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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Run npm install inside the checkout, streaming its output to the log. */
function npmInstall(cwd, log, onProgress) {
  const cacheDir = path.join(os.tmpdir(), 'stm-npm-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* fall back to the default */ }

  return new Promise((resolve, reject) => {
    log.info('Installing SillyTavern dependencies (npm install)...');
    log.info('On a slow disk this can take several minutes; SillyTavern will not start until it finishes.');
    const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=info'];
    const child = spawn(npmCommand(), args, {
      cwd,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        npm_config_update_notifier: 'false',
        // Keep npm's cache and scratch space off the persistent volume: on
        // ModelScope that volume is network-backed, and npm writes tens of
        // thousands of small files. Local disk turns an hour into minutes.
        npm_config_cache: cacheDir,
        TMPDIR: cacheDir,
      },
    });
    child.stdout.on('data', (d) => {
      log.info(String(d).trimEnd());
      if (onProgress) onProgress({ phase: 'npm', line: String(d).trim().slice(0, 120) });
    });
    child.stderr.on('data', (d) => {
      const text = String(d).trimEnd();
      // npm writes ordinary progress to stderr; only real errors are errors.
      log[/\bERR!|error\b/i.test(text) ? 'error' : 'info'](text);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`npm install exited with code ${code}`))));
  });
}

/**
 * Install (or reinstall) SillyTavern.
 *
 * Existing user data is never touched: we extract the new code over the top and
 * leave data/ and public/ alone. A failed download or extraction leaves the old
 * install in place, because we stage into a temp directory first.
 */
async function install({ selection, paths, log, onProgress = () => {} }) {
  const target = await resolveDownload(selection);
  log.info(`Selected SillyTavern ${target.version} (${target.kind})`);
  onProgress({ phase: 'resolve', version: target.version, percent: 2 });

  // From here on the checkout is not trustworthy until the marker is rewritten.
  ST.clearMarker(paths.stRoot);

  const stage = path.join(paths.tmpDir, `st-${Date.now()}`);
  const zipFile = path.join(paths.tmpDir, `st-${Date.now()}.zip`);
  await fsp.mkdir(stage, { recursive: true });

  try {
    log.info(`Downloading ${target.url}`);
    let lastPct = -1;
    await download(target.url, zipFile, ({ received, total }) => {
      const pct = total ? Math.round((received / total) * 100) : 0;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        onProgress({ phase: 'download', percent: 2 + pct * 0.38, received, total });
      }
    });
    const zipSize = (await fsp.stat(zipFile)).size;
    log.info(`Downloaded ${(zipSize / 1e6).toFixed(1)} MB`);

    onProgress({ phase: 'extract', percent: 42 });
    log.info('Extracting...');
    // GitHub zipballs wrap everything in "SillyTavern-<ref>/".
    const result = await extractZip(zipFile, stage, {
      stripComponents: 1,
      onProgress: ({ done, total }) => {
        onProgress({ phase: 'extract', percent: 42 + (done / Math.max(total, 1)) * 18, done, total });
      },
    });
    log.info(`Extracted ${result.written} files`);

    if (!fs.existsSync(path.join(stage, 'server.js'))) {
      throw new Error('archive did not contain server.js - not a SillyTavern release?');
    }

    // Move code into place, preserving any existing user data directories.
    onProgress({ phase: 'place', percent: 62 });
    await fsp.mkdir(paths.stRoot, { recursive: true });
    const keep = new Set(['data', 'public', 'node_modules', 'config.yaml', 'plugins']);
    for (const entry of await fsp.readdir(stage, { withFileTypes: true })) {
      const from = path.join(stage, entry.name);
      const to = path.join(paths.stRoot, entry.name);
      if (keep.has(entry.name) && fs.existsSync(to)) {
        // public/ carries both front-end assets and (on legacy installs) user
        // data, so merge into it rather than replacing it.
        if (entry.name === 'public') {
          await mergeInto(from, to);
          continue;
        }
        if (entry.name === 'config.yaml') continue; // never clobber user config
        continue;
      }
      await fsp.rm(to, { recursive: true, force: true });
      await fsp.rename(from, to).catch(async () => {
        await copyDir(from, to);
      });
    }

    onProgress({ phase: 'npm', percent: 70 });
    await npmInstall(paths.stRoot, log, onProgress);

    const layout = ST.detectLayout(paths.stRoot);
    const version = (await ST.installedVersion(paths.stRoot)) || target.version;
    await ST.writeMarker(paths.stRoot, { version, requested: target.version, kind: target.kind, layout });
    log.info(`SillyTavern ${version} installed (${layout} layout) at ${paths.stRoot}`);
    onProgress({ phase: 'done', percent: 100, version, layout });

    return { version, requested: target.version, kind: target.kind, layout, root: paths.stRoot };
  } finally {
    await fsp.rm(zipFile, { force: true }).catch(() => {});
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Recursive copy that does not overwrite existing files. */
async function mergeInto(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await mergeInto(s, d);
    else await fsp.copyFile(s, d).catch(() => {});
  }
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

module.exports = { listVersions, resolveDownload, install, download, npmInstall, REPO };
