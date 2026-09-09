'use strict';
/**
 * The admin page, served as one self-contained HTML string.
 * Deliberately dependency-free: no CDN, no build step, no EventSource.
 */

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Control</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#9aa4b6;--accent:#6ea8fe;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
  header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:600}
  main{padding:20px;max-width:1100px;margin:0 auto}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card h2{font-size:13px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
  .kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line)}
  .kv:last-child{border-bottom:0}
  .kv span:first-child{color:var(--dim)}
  .kv span:last-child{text-align:right;word-break:break-all}
  button{background:var(--accent);color:#0b1020;border:0;border-radius:7px;padding:8px 14px;font-weight:600;cursor:pointer;font-size:13px}
  button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
  button:disabled{opacity:.5;cursor:not-allowed}
  input{background:#0b0e13;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:9px 11px;width:100%;font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)}
  th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  pre{background:#0b0e13;border:1px solid var(--line);border-radius:7px;padding:12px;overflow:auto;max-height:320px;font-size:12px;margin:0}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600}
  .ok{background:rgba(74,222,128,.15);color:var(--ok)}
  .warn{background:rgba(251,191,36,.15);color:var(--warn)}
  .bad{background:rgba(248,113,113,.15);color:var(--bad)}
  a{color:var(--accent)}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .muted{color:var(--dim);font-size:12px}
  #login{max-width:340px;margin:15vh auto}
  ul{margin:8px 0;padding-left:18px}
  li{margin:3px 0}
  .hide{display:none}
</style>
</head>
<body>

<div id="login">
  <div class="card">
    <h2>SillyTavern Control</h2>
    <p class="muted" id="loginNote">Enter the admin password. On first boot it is printed in the Studio runtime logs.</p>
    <input id="pw" type="password" placeholder="Admin password" autocomplete="current-password">
    <div class="row" style="margin-top:12px"><button id="loginBtn">Sign in</button></div>
    <p id="loginErr" class="muted"></p>
    <details style="margin-top:14px">
      <summary class="muted" style="cursor:pointer">What does this collect?</summary>
      <div id="discPublic" class="muted"></div>
    </details>
  </div>
</div>

<div id="app" class="hide">
<header>
  <h1>SillyTavern Control</h1>
  <span id="stPill" class="pill">…</span>
  <span id="persistPill" class="pill">…</span>
  <div style="flex:1"></div>
  <a href="/" target="_blank">Open SillyTavern →</a>
</header>

<main>
  <div class="grid">

    <div class="card">
      <h2>Status</h2>
      <div id="statusBox"></div>
    </div>

    <div class="card">
      <h2>Public URL</h2>
      <div id="tunnelBox"></div>
      <p class="muted" style="margin-bottom:0">The trycloudflare address changes every time the Studio wakes. When the
      Studio is asleep this link is dead &mdash; open the ModelScope Studio page to wake it.</p>
    </div>

    <div class="card">
      <h2>Backups</h2>
      <div class="row" style="margin-bottom:10px">
        <button id="backupBtn">Back up now</button>
        <button class="ghost" id="uploadBtn">Restore from file…</button>
        <input id="file" type="file" accept=".gz,.tar.gz" class="hide">
      </div>
      <div id="backupMsg" class="muted"></div>
      <table><thead><tr><th>Name</th><th>Size</th><th>Where</th><th></th></tr></thead>
      <tbody id="backupRows"></tbody></table>
    </div>

    <div class="card">
      <h2>Usage by model</h2>
      <table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th></tr></thead>
      <tbody id="usageRows"></tbody></table>
      <p class="muted">Counted locally on this machine, for your own reference.</p>
    </div>

    <div class="card" style="grid-column:1/-1">
      <h2>Data sharing</h2>
      <div id="consentBox"></div>
      <div class="grid" style="margin-top:12px">
        <div><strong>Collected</strong><ul id="collectList"></ul></div>
        <div><strong>Never collected</strong><ul id="neverList"></ul></div>
      </div>
      <p class="muted">Below is the exact payload queued to be sent &mdash; nothing else leaves this machine.</p>
      <pre id="previewBox">{}</pre>
    </div>

    <div class="card" style="grid-column:1/-1">
      <h2>Logs</h2>
      <pre id="logBox"></pre>
    </div>

  </div>
</main>
</div>

<script>
const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => !b ? '0 B' : (b/1048576 >= 1 ? (b/1048576).toFixed(1)+' MB' : (b/1024).toFixed(0)+' KB');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function api(path, opts) {
  const res = await fetch('/_admin/api' + path, { credentials:'same-origin', ...opts });
  if (res.status === 401) { show(false); throw new Error('unauthorized'); }
  return res;
}
function show(loggedIn) {
  $('login').classList.toggle('hide', loggedIn);
  $('app').classList.toggle('hide', !loggedIn);
}

// ---- login ----------------------------------------------------------------
$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  const res = await fetch('/_admin/api/login', {
    method:'POST', credentials:'same-origin',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ password: $('pw').value }),
  });
  if (!res.ok) { $('loginErr').textContent = 'Wrong password.'; return; }
  show(true); refresh(); setInterval(refresh, 5000);
};
$('pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// ---- rendering ------------------------------------------------------------
function renderStatus(s) {
  const st = s.sillytavern;
  $('stPill').className = 'pill ' + (st.running ? 'ok' : 'bad');
  $('stPill').textContent = st.running ? 'SillyTavern up' : 'SillyTavern down';
  const p = s.persistence;
  $('persistPill').className = 'pill ' + (p && p.persistent ? 'ok' : 'bad');
  $('persistPill').textContent = p && p.persistent ? 'Storage persistent' : 'NOT persistent';

  $('statusBox').innerHTML = [
    ['Data directory', s.paths.data],
    ['Data size', fmtBytes(s.storage.bytes) + ' (' + s.storage.files + ' files)'],
    ['Survives restart', p && p.persistent ? 'yes' : 'NO - fix this'],
    ['ST restarts', st.restarts],
    ['Uptime', Math.floor(s.uptimeSec/60) + 'm ' + (s.uptimeSec%60) + 's'],
    ['Install ID', s.installId],
  ].map(([k,v]) => '<div class="kv"><span>'+esc(k)+'</span><span>'+esc(v)+'</span></div>').join('');

  const t = s.tunnel;
  $('tunnelBox').innerHTML = t.url
    ? '<div class="kv"><span>Status</span><span class="pill ok">'+esc(t.status)+'</span></div>' +
      '<div class="kv"><span>URL</span><span><a href="'+esc(t.url)+'" target="_blank">'+esc(t.url)+'</a></span></div>'
    : '<div class="kv"><span>Status</span><span class="pill warn">'+esc(t.status)+'</span></div>';

  const c = s.telemetry;
  $('consentBox').innerHTML =
    '<div class="kv"><span>Reporting</span><span class="pill '+(c.consent?'ok':'warn')+'">'+(c.consent?'on':'off')+'</span></div>' +
    '<div class="kv"><span>Sent to</span><span>'+esc(c.endpoint || 'not configured')+'</span></div>' +
    '<div class="kv"><span>Queued events</span><span>'+c.queued+'</span></div>' +
    '<div class="row" style="margin-top:10px"><button class="ghost" id="consentBtn">'+
      (c.consent ? 'Turn reporting off' : 'Turn reporting on')+'</button></div>';
  $('consentBtn').onclick = async () => {
    await api('/telemetry/consent', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ consent: !c.consent }) });
    refresh();
  };
}

function renderBackups(b) {
  const rows = [...b.local, ...b.remote];
  $('backupRows').innerHTML = rows.length ? rows.map(r =>
    '<tr><td>'+esc(r.name)+'</td><td>'+fmtBytes(r.bytes)+'</td><td>'+esc(r.where)+'</td>' +
    '<td class="row">' +
      (r.where==='local' ? '<a href="/_admin/api/download?name='+encodeURIComponent(r.name)+'">get</a>' : '') +
      ' <button class="ghost" data-name="'+esc(r.name)+'" data-from="'+esc(r.where==='r2'?'r2':'local')+'">restore</button>' +
    '</td></tr>').join('') : '<tr><td colspan="4" class="muted">No backups yet.</td></tr>';

  $('backupRows').querySelectorAll('button[data-name]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Restore ' + btn.dataset.name + '? Current data is snapshotted first.')) return;
      btn.disabled = true;
      const res = await api('/restore', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ name: btn.dataset.name, from: btn.dataset.from }) });
      const out = await res.json();
      $('backupMsg').textContent = out.error ? ('Error: ' + out.error)
        : ('Restored. Safety copy: ' + out.safety + '. SillyTavern is restarting.');
      btn.disabled = false; refresh();
    };
  });
}

$('backupBtn').onclick = async () => {
  $('backupBtn').disabled = true;
  $('backupMsg').textContent = 'Creating backup…';
  const out = await (await api('/backup', { method:'POST' })).json();
  $('backupMsg').textContent = out.error ? ('Error: ' + out.error)
    : ('Created ' + out.name + ' (' + fmtBytes(out.bytes) + ')' + (out.remote ? ' and uploaded to R2.' : '.'));
  $('backupBtn').disabled = false; refresh();
};
$('uploadBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  $('backupMsg').textContent = 'Uploading ' + f.name + '…';
  const out = await (await api('/upload', { method:'POST', body: f })).json();
  $('backupMsg').textContent = out.error ? ('Error: ' + out.error)
    : ('Imported and restored. Safety copy: ' + out.safety + '.');
  refresh();
};

async function loadDisclosure(target) {
  const d = await (await fetch('/_admin/api/disclosure')).json();
  const ul = (items) => '<ul>' + items.map(i => '<li>'+esc(i)+'</li>').join('') + '</ul>';
  if (target === 'public') { $('discPublic').innerHTML = ul(d.collected) + '<strong>Never:</strong>' + ul(d.neverCollected); return; }
  $('collectList').innerHTML = d.collected.map(i => '<li>'+esc(i)+'</li>').join('');
  $('neverList').innerHTML = d.neverCollected.map(i => '<li>'+esc(i)+'</li>').join('');
}

async function refresh() {
  try {
    const s = await (await api('/status')).json();
    renderStatus(s);
    renderBackups(await (await api('/backups')).json());
    const u = await (await api('/telemetry/summary')).json();
    $('usageRows').innerHTML = u.rows.length ? u.rows.map(r =>
      '<tr><td>'+esc(r.provider)+'</td><td>'+esc(r.model)+'</td><td>'+r.count+'</td></tr>').join('')
      : '<tr><td colspan="3" class="muted">No generations yet.</td></tr>';
    $('previewBox').textContent = JSON.stringify(u.preview, null, 2);
    const l = await (await api('/logs')).json();
    $('logBox').textContent = l.lines.map(x => x.ts.slice(11,19) + ' ' + x.level.padEnd(5) + ' ' + x.msg).join('\\n');
    $('logBox').scrollTop = $('logBox').scrollHeight;
    loadDisclosure();
  } catch (e) { /* session expired; login view is already showing */ }
}

// Try an existing cookie session on load.
(async () => {
  loadDisclosure('public');
  const res = await fetch('/_admin/api/status', { credentials:'same-origin' });
  if (res.ok) { show(true); refresh(); setInterval(refresh, 5000); }
  else show(false);
})();
</script>
</body>
</html>`;

module.exports = { page: () => HTML };
