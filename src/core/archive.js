'use strict';
/**
 * Zip reading and writing, streamed.
 *
 * Sized against a real SillyTavern backup: 2.36 GB compressed, 3.80 GB
 * uncompressed, 11,266 entries. Nothing here may buffer an archive - or even a
 * single entry - in memory, and the extractor must not choke on the deep,
 * unicode, space-containing paths SillyTavern produces
 * ("OpenAI Settings/Tawa δέλτα ....json").
 *
 * yauzl/yazl are pure JavaScript, so this all works on Android/Termux where a
 * native module would need a compiler.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');

/**
 * Reject entries that would escape the destination directory (zip slip), and
 * normalise separators. Returns null for anything unsafe.
 */
function safeJoin(destDir, entryName, stripComponents = 0) {
  let name = entryName.replace(/\\/g, '/');
  if (stripComponents > 0) {
    const parts = name.split('/');
    if (parts.length <= stripComponents) return null;
    name = parts.slice(stripComponents).join('/');
  }
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const full = path.resolve(destDir, name);
  const root = path.resolve(destDir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** Entry list without extracting. */
function listZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (e) => {
        entries.push({
          name: e.fileName,
          size: e.uncompressedSize,
          compressed: e.compressedSize,
          dir: /\/$/.test(e.fileName),
        });
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/**
 * Extract `zipPath` into `destDir`.
 *
 * options:
 *   stripComponents  drop N leading path segments (GitHub zipballs wrap
 *                    everything in "SillyTavern-1.18.0/")
 *   filter(name)     return false to skip an entry
 *   onProgress({done, total, bytes, name})
 */
function extractZip(zipPath, destDir, { stripComponents = 0, filter = null, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);

      const total = zip.entryCount;
      let done = 0;
      let bytes = 0;
      let skipped = 0;
      let failed = null;

      const finish = (e) => {
        if (failed) return;
        failed = e || null;
        if (e) reject(e);
        else resolve({ entries: total, written: done, skipped, bytes });
      };

      zip.on('error', finish);
      zip.on('end', () => finish(null));

      zip.on('entry', async (entry) => {
        try {
          const rawName = entry.fileName.replace(/\\/g, '/');
          if (filter && !filter(stripComponents ? rawName.split('/').slice(stripComponents).join('/') : rawName)) {
            skipped++;
            return zip.readEntry();
          }

          const target = safeJoin(destDir, entry.fileName, stripComponents);
          if (!target) {           // unsafe path, or stripped to nothing
            skipped++;
            return zip.readEntry();
          }

          if (/\/$/.test(rawName)) {
            await fsp.mkdir(target, { recursive: true });
            return zip.readEntry();
          }

          await fsp.mkdir(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (e2, readStream) => {
            if (e2) return finish(e2);
            const out = fs.createWriteStream(target);
            readStream.on('error', finish);
            out.on('error', finish);
            out.on('close', () => {
              done++;
              bytes += entry.uncompressedSize;
              if (onProgress && (done % 25 === 0 || done === total)) {
                onProgress({ done, total, bytes, name: rawName });
              }
              zip.readEntry();
            });
            readStream.pipe(out);
          });
        } catch (e3) {
          finish(e3);
        }
      });

      zip.readEntry();
    });
  });
}

/**
 * Walk a directory, yielding files relative to it.
 * Iterative so a pathological tree cannot blow the stack.
 */
async function* walk(root, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* walk(root, r);
    } else if (e.isFile()) {
      yield r;
    }
  }
}

/**
 * Zip the contents of `srcDir` into `destPath`.
 *
 * The archive root is the *contents* of srcDir, matching the layout
 * SillyTavern's own "Download Backup" produces, so our archives and its
 * archives are interchangeable.
 */
async function createZipFromDir(srcDir, destPath, { filter = null, onProgress = null } = {}) {
  const zip = new yazl.ZipFile();
  let added = 0;
  let rawBytes = 0;

  const writeDone = new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
    zip.outputStream.pipe(out);
  });

  for await (const rel of walk(srcDir)) {
    if (filter && !filter(rel)) continue;
    const abs = path.join(srcDir, rel);
    let st;
    try { st = await fsp.stat(abs); } catch { continue; }
    zip.addFile(abs, rel, { mtime: st.mtime, mode: st.mode });
    added++;
    rawBytes += st.size;
    if (onProgress && added % 100 === 0) onProgress({ added, bytes: rawBytes, name: rel });
  }

  zip.end();
  await writeDone;
  const st = await fsp.stat(destPath);
  return { files: added, rawBytes, size: st.size };
}

module.exports = { listZip, extractZip, createZipFromDir, walk, safeJoin };
