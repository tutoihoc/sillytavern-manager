/* SillyTavern Manager — control panel.
   Vanilla JS, no build step, no CDN: the app has to work with no internet.

   Polling, never EventSource: a GET text/event-stream is buffered end-to-end by
   Cloudflare quick tunnels, so a live log built on it would look frozen to
   anyone connecting through the tunnel. */
'use strict';

const API = '/manager/api';
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : i === 1 ? 0 : 1)} ${u[i]}`;
};
const fmtNum = (n) => (n == null ? '—' : n.toLocaleString());
const fmtDur = (s) => {
  if (!s) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString();
};

// ── transport ────────────────────────────────────────────────

async function api(path, { method = 'GET', body, raw, signal } = {}) {
  const res = await fetch(API + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined && !raw ? { 'content-type': 'application/json' } : undefined,
    body: raw ? body : (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status === 401 && State.booted) { State.authenticated = false; render(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, kind === 'bad' ? 7000 : 4000);
}

// ── state ────────────────────────────────────────────────────

const State = {
  booted: false,
  authenticated: false,
  needsPassword: false,
  needsTerms: false,
  installed: false,
  status: null,
  route: (location.hash.replace('#', '') || 'dashboard'),
  theme: localStorage.getItem('stm-theme') || 'dark',
  logs: { lines: [], lastId: 0, source: 'all', level: 'all', q: '', live: true },
  usage: null,
  backups: null,
  config: null,
  job: null,
  timers: [],
};

document.documentElement.dataset.theme = State.theme;

function stopTimers() { State.timers.forEach(clearInterval); State.timers = []; }
function every(ms, fn) { const id = setInterval(fn, ms); State.timers.push(id); return id; }

// ── icons ────────────────────────────────────────────────────

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  backups: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16M4 10h10M4 15h16M4 20h7"/></svg>',
  usage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 20h18"/><path d="M6 20V11M11 20V5M16 20v-6M21 20v-9"/></svg>',
  config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20 11a2 2 0 1 1 0 4z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
};

// ── gates ────────────────────────────────────────────────────

function viewTerms(boot) {
  const t = boot.terms;
  return `
  <div class="gate"><div class="gate-card">
    <div class="brand"><div class="brand-mark">ST</div>
      <div class="brand-text"><b>SillyTavern Manager</b><span>v${esc(boot.version)}</span></div></div>
    <h2>Before you start</h2>
    <p style="color:var(--ink-dim);font-size:13.5px;margin:10px 0 0">${esc(t.summary)}</p>
    <ul>${t.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <div class="modal-row" style="display:flex;gap:9px;margin-top:22px">
      <button class="primary" id="acceptTerms">Accept and continue</button>
    </div>
  </div></div>`;
}

function viewPassword(boot) {
  const first = boot.needsPassword;
  const needsCode = boot.needsSetupCode;
  return `
  <div class="gate"><div class="gate-card">
    <div class="brand"><div class="brand-mark">ST</div>
      <div class="brand-text"><b>SillyTavern Manager</b><span>v${esc(boot.version)}</span></div></div>
    <h2>${first ? 'Claim this manager' : 'Sign in'}</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin:8px 0 16px">
      ${first
        ? (needsCode
          ? 'Nobody has set a password yet. Prove this is yours with the setup code printed in the server log, then choose a password.'
          : 'Choose a password for the control panel. It is separate from any SillyTavern login.')
        : 'Enter the control panel password.'}</p>

    ${needsCode ? `<label class="field"><span class="name">Setup code</span>
      <input id="code" placeholder="e.g. 3F9A2C71" autocomplete="off" spellcheck="false"
             style="font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase">
      <span class="help">Look for <code>SETUP CODE:</code> in the log. On ModelScope that is
      Settings &rarr; View log &rarr; Run log. A new one is issued every restart.</span></label>` : ''}

    <label class="field"><span class="name">${first ? 'New password' : 'Password'}</span>
      <input type="password" id="pw" autocomplete="${first ? 'new-password' : 'current-password'}" autofocus></label>
    ${first ? '<label class="field"><span class="name">Confirm password</span><input type="password" id="pw2" autocomplete="new-password"></label>' : ''}
    <button class="primary" id="doLogin" style="width:100%;justify-content:center">${first ? 'Set password' : 'Sign in'}</button>
    <p id="loginErr" style="color:var(--bad);font-size:12.5px;margin:10px 0 0;min-height:1em"></p>
  </div></div>`;
}

// ── shell ────────────────────────────────────────────────────

const NAV = [
  ['dashboard', 'Dashboard'],
  ['backups', 'Backups'],
  ['logs', 'Logs'],
  ['usage', 'Usage'],
  ['config', 'Config'],
  ['settings', 'Settings'],
];

function annunciator(s) {
  if (!s) return '';
  const st = s.sillytavern || {};
  const tun = s.tunnel || {};
  const dur = s.platform.durability || {};
  const bk = s.backup || {};

  const stState = !s.setup.installed ? 'warn' : st.state === 'running' ? 'ok' : st.state === 'crashed' ? 'bad' : 'warn';
  const stText = !s.setup.installed ? 'Not installed'
    : st.state === 'running' ? `Running · port ${st.port}`
    : st.state === 'starting' ? 'Starting…' : st.state === 'crashed' ? 'Crashed' : 'Stopped';

  const tunState = !tun.enabled ? 'off' : tun.state === 'up' ? 'ok' : tun.state === 'error' ? 'bad' : 'warn';
  const tunText = !tun.enabled ? 'Disabled'
    : tun.url ? tun.url.replace('https://', '')
    : tun.state === 'error' ? (tun.error || 'Failed') : 'Connecting…';

  const durState = dur.durable ? 'ok' : dur.unknown ? 'warn' : 'bad';
  const durText = dur.durable ? s.platform.label : 'Data may not survive a restart';

  const last = bk.last;
  const bkState = !last ? 'warn' : 'ok';
  const bkText = last ? `${fmtWhen(last.at)} · ${fmtBytes(last.bytes)}` : 'No backup yet';

  return `<div class="annunciator">
    <div class="ann" data-state="${stState}"><i class="lamp"></i><div class="ann-text"><b>SillyTavern</b><span>${esc(stText)}</span></div></div>
    <div class="ann" data-state="${tunState}"><i class="lamp"></i><div class="ann-text"><b>Public link</b><span>${tun.url ? `<a href="${esc(tun.url)}" target="_blank" rel="noopener">${esc(tunText)}</a>` : esc(tunText)}</span></div></div>
    <div class="ann" data-state="${durState}"><i class="lamp"></i><div class="ann-text"><b>Storage</b><span>${esc(durText)}</span></div></div>
    <div class="ann" data-state="${bkState}"><i class="lamp"></i><div class="ann-text"><b>Last backup</b><span>${esc(bkText)}</span></div></div>
  </div>`;
}

function shell(inner) {
  const s = State.status;
  return `
  <div class="shell">
    <nav class="rail">
      <div class="brand"><div class="brand-mark">ST</div>
        <div class="brand-text"><b>Manager</b><span>v${esc(s ? s.version : '')}</span></div></div>
      ${NAV.map(([id, label]) => `
        <div class="navlink" data-nav="${id}" aria-current="${State.route === id}">
          ${ICONS[id]}<span>${label}</span></div>`).join('')}
      <div class="rail-foot">
        <button class="ghost sm" id="themeBtn" style="justify-content:center">
          ${State.theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
        <button class="ghost sm" id="logoutBtn" style="justify-content:center">Sign out</button>
      </div>
    </nav>
    <main class="main">
      ${annunciator(s)}
      <div class="view" id="view">${inner}</div>
    </main>
  </div>`;
}

// ── dashboard / setup ────────────────────────────────────────

function viewSetup() {
  return `
    <div class="page-head">
      <div><h1>Set up SillyTavern</h1>
      <p>Pick a version and the manager will download it, install its dependencies and start it.
         Nothing else to install by hand.</p></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <header><h2>1 · Version</h2></header>
        <label class="field"><span class="name">SillyTavern release</span>
          <select id="verSelect"><option>Loading versions…</option></select>
          <span class="help" id="verHelp">Fetched live from the official SillyTavern repository.</span></label>
        <label class="switch">
          <input type="checkbox" id="tunToggle" checked><span class="track"></span>
          <span class="txt"><b>Create a public link</b>
          <span>A Cloudflare quick tunnel, so you can open SillyTavern from a phone. Required on ModelScope.</span></span>
        </label>
      </div>
      <div class="card">
        <header><h2>2 · Install</h2></header>
        <p style="color:var(--ink-dim);font-size:13px;margin:0 0 14px">
          Downloading and installing usually takes two to five minutes. You can watch every step in the log below.</p>
        <button class="primary" id="installBtn">Install SillyTavern</button>
        <div id="installProgress" style="margin-top:16px;display:none">
          <div class="bar"><i style="width:0%"></i></div>
          <p class="mono" style="font-size:12px;color:var(--muted);margin:8px 0 0" id="installPhase">starting…</p>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <header><h2>Installer log</h2><div class="spacer"></div>
        <span class="eyebrow" id="logCount"></span></header>
      <div class="logbox" id="setupLog"></div>
    </div>`;
}

function viewDashboard() {
  const s = State.status;
  if (!s.setup.installed) return viewSetup();
  const st = s.sillytavern;
  const running = st.state === 'running';

  return `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>SillyTavern ${esc(s.setup.version || '')} on ${esc(s.platform.label)}.</p></div>
      <div class="spacer"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${running
          ? '<button id="stBtn" data-act="stop">Stop</button><button id="stRestart">Restart</button>'
          : '<button class="primary" id="stBtn" data-act="start">Start SillyTavern</button>'}
        <a class="btn" href="/" target="_blank" rel="noopener">Open SillyTavern ↗</a>
      </div>
    </div>

    ${!s.platform.durability.durable ? `<div class="notice ${s.platform.durability.unknown ? 'warn' : 'bad'}" style="margin-bottom:14px">
      <b>${s.platform.durability.unknown ? 'Storage may not persist.' : 'Storage does not persist.'}</b>
      ${esc(s.platform.durability.reason)} Turn on off-site backups under Backups so a restart cannot cost you anything.
    </div>` : ''}

    <div class="grid cols-4">
      <div class="card stat"><div class="label">Status</div>
        <div class="value sm" style="color:var(--${running ? 'ok' : 'warn'})">${esc(st.state)}</div>
        <div class="sub">${running ? `up ${fmtDur(st.uptimeSec)}` : `${st.restarts} restarts`}</div></div>
      <div class="card stat"><div class="label">Public link</div>
        <div class="value sm">${s.tunnel.url ? '<span style="color:var(--ok)">live</span>' : `<span style="color:var(--muted)">${esc(s.tunnel.enabled ? s.tunnel.state : 'off')}</span>`}</div>
        <div class="sub">${s.tunnel.url ? `<a href="${esc(s.tunnel.url)}" target="_blank" rel="noopener">${esc(s.tunnel.url.replace('https://', ''))}</a>` : 'No public URL'}</div></div>
      <div class="card stat"><div class="label">Last backup</div>
        <div class="value sm">${s.backup.last ? fmtBytes(s.backup.last.bytes) : '—'}</div>
        <div class="sub">${s.backup.last ? fmtWhen(s.backup.last.at) : 'never'}</div></div>
      <div class="card stat"><div class="label">Usage today</div>
        <div class="value sm" id="todayReq">—</div><div class="sub" id="todayTok">loading…</div></div>
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <header><h2>Where things live</h2></header>
        <dl class="kv">
          <dt>Platform</dt><dd>${esc(s.platform.label)}${s.platform.container ? ' · container' : ''}</dd>
          <dt>Manager data</dt><dd>${esc(s.platform.home)}</dd>
          <dt>SillyTavern</dt><dd>${esc(s.setup.dataDir || '—')}</dd>
          <dt>Layout</dt><dd>${esc(s.setup.layout || '—')} ${s.setup.layout === 'public' ? '<span class="pill warn">legacy</span>' : ''}</dd>
          <dt>Persistent</dt><dd>${s.platform.durability.durable ? '<span class="pill ok">yes</span>' : '<span class="pill bad">no</span>'}</dd>
        </dl>
      </div>
      <div class="card">
        <header><h2>Recent activity</h2><div class="spacer"></div>
          <button class="ghost sm" data-nav="logs">All logs</button></header>
        <div class="logbox" style="height:220px" id="dashLog"></div>
      </div>
    </div>`;
}

// ── backups ──────────────────────────────────────────────────

function viewBackups() {
  const b = State.backups;
  if (!b) return '<div class="card">Loading backups…</div>';
  const st = b.settings || {};
  const r = st.remote || {};
  const est = State.estimate || {};

  const rows = [...(b.local || []), ...(b.remote || [])];

  return `
    <div class="page-head">
      <div><h1>Backups</h1><p>Archives are the same shape as SillyTavern's own “Download Backup”, so files move freely between the two.</p></div>
      <div class="spacer"></div>
      <button class="primary" id="bkNow">Back up now</button>
      <button id="bkUpload">Restore from file…</button>
      <input type="file" id="bkFile" accept=".zip" hidden>
    </div>

    <div id="bkJob"></div>

    <div class="grid cols-2">
      <div class="card">
        <header><h2>What to include</h2></header>
        ${Object.entries(b.profiles).map(([id, p]) => `
          <label class="switch" style="align-items:center">
            <input type="radio" name="profile" value="${id}" ${st.profile === id ? 'checked' : ''} style="display:none">
            <span class="track" style="border-radius:6px"></span>
            <span class="txt"><b>${esc(p.label)} ${est[id] ? `<span class="pill">${fmtBytes(est[id].bytes)} · ${fmtNum(est[id].files)} files</span>` : ''}</b>
            <span>${esc(p.hint)}</span></span>
          </label>`).join('')}
        <label class="switch">
          <input type="checkbox" id="incSecrets" ${st.includeSecrets ? 'checked' : ''}><span class="track"></span>
          <span class="txt"><b>Include secrets.json (your API keys)</b>
          <span>Needed for a restore that just works. Leave off if backups go to cloud storage you would rather not trust with keys.</span></span>
        </label>
      </div>

      <div class="card">
        <header><h2>Schedule</h2></header>
        <label class="field"><span class="name">Automatic backup every</span>
          <select id="bkInterval">
            ${[0, 15, 30, 60, 180, 360, 720, 1440].map((m) => `<option value="${m}" ${Number(st.intervalMinutes) === m ? 'selected' : ''}>${m === 0 ? 'Never' : m < 60 ? `${m} minutes` : m === 60 ? 'hour' : m === 1440 ? '24 hours' : `${m / 60} hours`}</option>`).join('')}
          </select>
          <span class="help">A run that finds nothing changed is skipped, so a quiet day costs nothing.</span></label>
        <label class="field"><span class="name">Keep locally</span>
          <input type="number" id="bkKeep" min="1" max="50" value="${esc(st.keepLocal ?? 5)}"></label>
        <label class="switch">
          <input type="checkbox" id="bkShutdown" ${st.onShutdown !== false ? 'checked' : ''}><span class="track"></span>
          <span class="txt"><b>Quick backup when shutting down</b>
          <span>Chats only, with a timeout — a multi-gigabyte archive cannot finish inside a shutdown.</span></span>
        </label>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <header><h2>Off-site storage (S3 / Cloudflare R2)</h2><div class="spacer"></div>
        ${b.status.remoteEnabled ? '<span class="pill ok">connected</span>' : '<span class="pill">not configured</span>'}</header>
      <label class="switch">
        <input type="checkbox" id="r2on" ${r.enabled ? 'checked' : ''}><span class="track"></span>
        <span class="txt"><b>Upload backups to object storage</b>
        <span>Cloudflare R2's free tier is 10 GB with free egress. Local backups die with the machine; these do not.</span></span>
      </label>
      <div class="grid cols-2" style="margin-top:8px">
        <label class="field"><span class="name">Endpoint</span>
          <input id="r2endpoint" placeholder="https://&lt;account-id&gt;.r2.cloudflarestorage.com" value="${esc(r.endpoint || '')}"></label>
        <label class="field"><span class="name">Bucket</span>
          <input id="r2bucket" placeholder="sillytavern-backups" value="${esc(r.bucket || '')}"></label>
        <label class="field"><span class="name">Access key ID</span>
          <input id="r2key" value="${esc(r.accessKeyId || '')}"></label>
        <label class="field"><span class="name">Secret access key</span>
          <input id="r2secret" type="password" value="${esc(r.secretAccessKey || '')}"></label>
        <label class="field"><span class="name">Path prefix</span>
          <input id="r2prefix" value="${esc(r.prefix || 'sillytavern')}"></label>
        <label class="field"><span class="name">Keep remotely</span>
          <input id="r2keep" type="number" min="1" max="50" value="${esc(r.keepRemote ?? 3)}">
          <span class="help">${est.full ? `At ${fmtBytes(est.full.bytes)} per full backup, ${r.keepRemote ?? 3} copies need about ${fmtBytes((est.full.bytes) * (r.keepRemote ?? 3))}.` : ''}</span></label>
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button id="r2test">Test connection</button>
        <button class="primary" id="bkSave">Save settings</button>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <header><h2>Archives</h2><div class="spacer"></div><span class="eyebrow">${rows.length} total</span></header>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Profile</th><th>Size</th><th>Where</th><th>When</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((x) => `
          <tr>
            <td class="mono" style="font-size:12px">${esc(x.name)}${x.foreign ? ' <span class="pill info">imported</span>' : ''}</td>
            <td>${esc(x.profile || '—')}${x.label ? ` <span class="pill">${esc(x.label)}</span>` : ''}</td>
            <td class="num">${fmtBytes(x.bytes)}</td>
            <td><span class="pill ${x.where === 'remote' ? 'info' : ''}">${x.where}</span></td>
            <td>${fmtWhen(x.at)}</td>
            <td class="actions">
              ${x.where === 'local' ? `<a class="btn sm" href="${API}/backups/download?name=${encodeURIComponent(x.name)}">Download</a>` : ''}
              <button class="sm" data-restore="${esc(x.name)}" data-from="${x.where}">Restore</button>
              ${x.where === 'local' ? `<button class="sm danger" data-del="${esc(x.name)}">Delete</button>` : ''}
            </td>
          </tr>`).join('') : '<tr><td colspan="6" style="color:var(--muted)">No backups yet.</td></tr>'}
        </tbody>
      </table></div>
    </div>`;
}

// ── logs ─────────────────────────────────────────────────────

function viewLogs() {
  return `
    <div class="page-head">
      <div><h1>Logs</h1><p>Everything SillyTavern, the tunnel and the manager print — no terminal needed.</p></div>
    </div>
    <div class="card">
      <header>
        <select id="logSource" style="width:auto;min-width:130px">
          ${['all', 'sillytavern', 'manager', 'cloudflared', 'installer', 'backup'].map((s) => `<option ${State.logs.source === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <select id="logLevel" style="width:auto;min-width:100px">
          ${['all', 'info', 'warn', 'error'].map((s) => `<option ${State.logs.level === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <input id="logSearch" placeholder="Search…" value="${esc(State.logs.q)}" style="max-width:220px">
        <div class="spacer"></div>
        <label class="switch" style="padding:0"><input type="checkbox" id="logLive" ${State.logs.live ? 'checked' : ''}><span class="track"></span>
          <span class="txt"><b style="font-size:12px">Live</b></span></label>
        <a class="btn sm" href="${API}/logs/download?source=${State.logs.source}">Download</a>
      </header>
      <div class="logbox" id="logBox"></div>
    </div>`;
}

function renderLogLines(box, lines, q) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = lines.map((l) => {
    const time = new Date(l.ts).toTimeString().slice(0, 8);
    let msg = esc(l.text);
    if (q) msg = msg.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return `<div class="logline" data-level="${l.level}"><span class="t">${time}</span><span class="s">${esc(l.source)}</span><span class="m">${msg}</span></div>`;
  }).join('') || '<div class="logline"><span class="t"></span><span class="s"></span><span class="m" style="color:var(--muted)">Nothing logged yet.</span></div>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ── usage ────────────────────────────────────────────────────

function lineChart(series, key, label) {
  const w = 720, h = 190, pad = { l: 46, r: 10, t: 12, b: 24 };
  const max = Math.max(1, ...series.map((d) => d[key]));
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const x = (i) => pad.l + (series.length <= 1 ? 0 : (i / (series.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;

  const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`);
  const area = `M${pad.l},${pad.t + ih} L${pts.join(' L')} L${x(series.length - 1)},${pad.t + ih} Z`;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <defs><linearGradient id="gAccent" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((t) => `<line class="gridline" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${pad.l - 8}" y="${y(t) + 3}" text-anchor="end">${t > 999 ? (t / 1000).toFixed(0) + 'k' : t}</text>`).join('')}
    <path class="area" d="${area}"/>
    <polyline class="line" points="${pts.join(' ')}"/>
    <text x="${pad.l}" y="${h - 6}">${esc(series[0]?.day.slice(5) || '')}</text>
    <text x="${w - pad.r}" y="${h - 6}" text-anchor="end">${esc(series[series.length - 1]?.day.slice(5) || '')}</text>
  </svg>`;
}

function barChart(rows, labelKey, valueKey) {
  if (!rows.length) return '<p style="color:var(--muted);font-size:13px">No data yet.</p>';
  const max = Math.max(...rows.map((r) => r[valueKey]));
  return `<div style="display:grid;gap:7px">${rows.slice(0, 8).map((r) => `
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 66px;gap:10px;align-items:center">
      <div style="min-width:0">
        <div style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r[labelKey])}</div>
        <div class="bar" style="margin-top:4px"><i style="width:${(r[valueKey] / max) * 100}%;animation:none"></i></div>
      </div>
      <div class="mono" style="font-size:12px;text-align:right;color:var(--ink-dim)">${fmtNum(r[valueKey])}</div>
    </div>`).join('')}</div>`;
}

function viewUsage() {
  const u = State.usage;
  if (!u) return '<div class="card">Loading usage…</div>';
  const t = u.totals;
  return `
    <div class="page-head">
      <div><h1>Usage</h1><p>Counted locally as requests pass through the manager.</p></div>
      <div class="spacer"></div>
      <button class="ghost sm" id="usageReset">Clear history</button>
    </div>

    <div class="grid cols-4">
      <div class="card stat"><div class="label">Requests</div><div class="value">${fmtNum(t.requests)}</div><div class="sub">last 30 days</div></div>
      <div class="card stat"><div class="label">Tokens</div><div class="value">${t.tokens > 999999 ? (t.tokens / 1e6).toFixed(2) + 'M' : fmtNum(t.tokens)}</div>
        <div class="sub">${fmtNum(t.promptTokens)} in · ${fmtNum(t.completionTokens)} out</div></div>
      <div class="card stat"><div class="label">Avg latency</div><div class="value">${t.avgDurationMs ? (t.avgDurationMs / 1000).toFixed(1) + 's' : '—'}</div><div class="sub">per generation</div></div>
      <div class="card stat"><div class="label">Errors</div><div class="value" style="color:var(--${t.errors ? 'bad' : 'ok'})">${fmtNum(t.errors)}</div><div class="sub">failed calls</div></div>
    </div>

    <div class="card" style="margin-top:14px">
      <header><h2>Requests per day</h2><div class="spacer"></div>
        <span class="legend"><span><i style="background:var(--accent)"></i>requests</span></span></header>
      ${lineChart(u.series, 'requests', 'Requests per day')}
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><header><h2>Models</h2></header>
        ${barChart(u.byModel.map((m) => ({ name: `${m.model}`, requests: m.requests })), 'name', 'requests')}</div>
      <div class="card"><header><h2>Providers</h2></header>
        ${barChart(u.byProvider.map((m) => ({ name: m.provider, requests: m.requests })), 'name', 'requests')}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <header><h2>Tokens per day</h2></header>
      ${lineChart(u.series, 'tokens', 'Tokens per day')}
    </div>

    <div class="card" style="margin-top:14px">
      <header><h2>What is reported</h2><div class="spacer"></div>
        <span class="pill ${u.telemetry.configured ? 'info' : ''}">${u.telemetry.configured ? 'reporting on' : 'no server configured'}</span></header>
      <p style="color:var(--ink-dim);font-size:13px;margin:0 0 10px">
        This is the exact payload queued for sending. Nothing else leaves this machine.</p>
      <div class="logbox" style="height:220px;padding:12px 14px"><pre class="mono" style="margin:0;font-size:11.5px;white-space:pre-wrap">${esc(JSON.stringify(u.telemetry.payload, null, 2))}</pre></div>
    </div>`;
}

// ── config ───────────────────────────────────────────────────

function viewConfig() {
  const c = State.config;
  if (!c) return '<div class="card">Loading config…</div>';
  const v = c.values || {};
  const shown = (f) => !f.showWhen || v[f.showWhen] === true;

  return `
    <div class="page-head">
      <div><h1>SillyTavern config</h1><p>Edits go straight into <code>config.yaml</code>. Your comments and key order are preserved.</p></div>
      <div class="spacer"></div>
      <button class="ghost sm" id="cfgRaw">Raw YAML</button>
      <button class="primary" id="cfgSave">Save and restart</button>
    </div>
    ${c.source !== 'config.yaml' ? `<div class="notice info" style="margin-bottom:14px">
      Showing SillyTavern's shipped defaults — <code>config.yaml</code> appears once SillyTavern has run at least once. Saving creates it.</div>` : ''}
    ${c.values.basicAuthMode !== true && c.values.enableUserAccounts !== true ? `<div class="notice warn" style="margin-bottom:14px">
      <b>SillyTavern has no password.</b> If you share the public link, anyone with it can read and write your chats.
      Turn on basic auth or user accounts below.</div>` : ''}

    ${c.schema.map((g) => `
      <div class="card" style="margin-bottom:14px">
        <header><h2>${esc(g.group)}</h2></header>
        ${g.blurb ? `<p style="color:var(--muted);font-size:12.5px;margin:-6px 0 12px">${esc(g.blurb)}</p>` : ''}
        ${g.fields.map((f) => {
          const val = v[f.key];
          if (!shown(f)) return '';
          if (f.type === 'boolean') return `
            <label class="switch"><input type="checkbox" data-cfg="${f.key}" ${val === true ? 'checked' : ''}>
              <span class="track"></span><span class="txt"><b>${esc(f.label)}</b>
              ${f.help ? `<span>${esc(f.help)}</span>` : ''}</span></label>`;
          return `
            <label class="field"><span class="name">${esc(f.label)}</span>
              <input type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}"
                     data-cfg="${f.key}" value="${esc(val ?? f.default ?? '')}"
                     placeholder="${esc(f.placeholder || '')}">
              ${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`;
        }).join('')}
      </div>`).join('')}`;
}

// ── settings ─────────────────────────────────────────────────

function viewSettings() {
  const s = State.status;
  return `
    <div class="page-head"><div><h1>Settings</h1><p>The manager itself.</p></div></div>
    <div class="grid cols-2">
      <div class="card">
        <header><h2>Public link</h2></header>
        <label class="switch"><input type="checkbox" id="setTunnel" ${s.tunnel.enabled ? 'checked' : ''}><span class="track"></span>
          <span class="txt"><b>Cloudflare quick tunnel</b>
          <span>The address changes every time the manager restarts. On ModelScope this is the only way in from a phone.</span></span></label>
        <label class="field"><span class="name">Announce new URLs to a webhook</span>
          <input id="setWebhook" placeholder="https://discord.com/api/webhooks/…" value="${esc(s.tunnel.webhookUrl || '')}">
          <span class="help">Because the URL changes on every restart, a Discord or Slack webhook is the easiest way to always have the current one.</span></label>
        <div style="display:flex;gap:8px"><button id="setTunnelSave" class="primary">Save</button>
          <button id="setTunnelRestart">Reconnect now</button></div>
      </div>
      <div class="card">
        <header><h2>SillyTavern process</h2></header>
        <label class="switch"><input type="checkbox" id="setAutostart" ${s.setup && State.settings?.sillytavern?.autoStart !== false ? 'checked' : ''}><span class="track"></span>
          <span class="txt"><b>Start automatically</b><span>Launch SillyTavern whenever the manager starts.</span></span></label>
        <label class="field"><span class="name">Internal port</span>
          <input type="number" id="setPort" value="${esc(s.sillytavern.port)}">
          <span class="help">Only used between the manager and SillyTavern. Change it if something else already listens there.</span></label>
        <button class="primary" id="setStSave">Save</button>
      </div>
      <div class="card">
        <header><h2>Panel password</h2></header>
        <label class="field"><span class="name">New password</span><input type="password" id="setPw"></label>
        <button class="primary" id="setPwSave">Change password</button>
      </div>
      <div class="card">
        <header><h2>Reinstall or update SillyTavern</h2></header>
        <p style="color:var(--ink-dim);font-size:13px;margin:0 0 12px">
          Installs a different version over the top. Your characters, chats and settings are left untouched.</p>
        <label class="field"><span class="name">Version</span><select id="setVersion"><option>Loading…</option></select></label>
        <button id="setReinstall">Install this version</button>
      </div>
    </div>`;
}

// ── render ───────────────────────────────────────────────────

const VIEWS = {
  dashboard: viewDashboard, backups: viewBackups, logs: viewLogs,
  usage: viewUsage, config: viewConfig, settings: viewSettings,
};

function render() {
  stopTimers();
  const root = $('#app');

  if (!State.booted) return;
  if (State.needsTerms) { root.innerHTML = viewTerms(State.boot); return wireTerms(); }
  if (!State.authenticated) { root.innerHTML = viewPassword(State.boot); return wireLogin(); }
  if (!State.status) { root.innerHTML = shell('<div class="card">Loading…</div>'); return; }

  const view = VIEWS[State.route] || viewDashboard;
  root.innerHTML = shell(view());
  wireShell();
  const wire = { dashboard: wireDashboard, backups: wireBackups, logs: wireLogs, usage: wireUsage, config: wireConfig, settings: wireSettings }[State.route];
  try { if (wire) wire(); } catch (err) {
    // A broken handler must not leave the panel stuck on a loading screen.
    console.error('wiring failed', err);
    toast(`Interface error: ${err.message}`, 'bad');
  }
}

function go(route) {
  State.route = route;
  location.hash = route;
  try { render(); } catch (err) { console.error(err); }
  loadRouteData();
}

// ── wiring ───────────────────────────────────────────────────

function wireTerms() {
  $('#acceptTerms').onclick = async () => {
    await api('/terms', { method: 'POST', body: { accept: true } });
    await boot();
  };
}

function wireLogin() {
  const btn = $('#doLogin');
  if (!btn) return;
  const submit = async () => {
    const pw = $('#pw').value;
    const pw2 = $('#pw2');
    if (pw2 && pw !== pw2.value) { $('#loginErr').textContent = 'The two passwords do not match.'; return; }
    btn.disabled = true;
    try {
      const code = $('#code');
      await api('/session', { method: 'POST', body: { password: pw, setupCode: code ? code.value : undefined } });
      await boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  if ($('#pw2')) $('#pw2').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

function wireShell() {
  document.querySelectorAll('[data-nav]').forEach((n) => { n.onclick = () => go(n.dataset.nav); });
  $('#themeBtn').onclick = () => {
    State.theme = State.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('stm-theme', State.theme);
    document.documentElement.dataset.theme = State.theme;
    render();
  };
  $('#logoutBtn').onclick = async () => {
    await api('/session', { method: 'DELETE' }).catch(() => {});
    State.authenticated = false; render();
  };
  every(5000, refreshStatus);
}

async function refreshStatus() {
  try {
    const s = await api('/status');
    const before = State.status;
    State.status = s;
    // Re-render only when something structural changed, to avoid stealing focus.
    const key = (x) => x && `${x.setup.installed}|${x.sillytavern.state}|${x.tunnel.state}|${x.tunnel.url}`;
    if (key(before) !== key(s)) render();
    else {
      const ann = $('.annunciator');
      if (ann) ann.outerHTML = annunciator(s);
    }
  } catch { /* transient */ }
}

// setup
async function wireSetupView() {
  const sel = $('#verSelect');
  if (!sel) return;
  try {
    const v = await api('/versions');
    sel.innerHTML = v.options.map((o) => `<option value="${esc(o.id)}" ${o.recommended ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  } catch (err) {
    sel.innerHTML = '<option value="latest">Latest release</option>';
    $('#verHelp').textContent = `Could not reach GitHub (${err.message}); "latest" will still work if the network returns.`;
  }

  $('#installBtn').onclick = async () => {
    const btn = $('#installBtn');
    btn.disabled = true;
    $('#installProgress').style.display = 'block';
    try {
      const { jobId } = await api('/install', {
        method: 'POST',
        body: { version: sel.value, enableTunnel: $('#tunToggle').checked, startAfter: true },
      });
      followJob(jobId, {
        bar: $('#installProgress .bar > i'),
        phase: $('#installPhase'),
        done: async () => { toast('SillyTavern installed', 'ok'); await refreshStatus(); go('dashboard'); },
        fail: (e) => { toast(`Install failed: ${e}`, 'bad'); btn.disabled = false; },
      });
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  };

  const box = $('#setupLog');
  every(1200, async () => {
    const r = await api(`/logs?since=${State.logs.lastId}&limit=400`).catch(() => null);
    if (!r) return;
    if (r.lines.length) { State.logs.lines.push(...r.lines); State.logs.lastId = r.lastId; }
    renderLogLines(box, State.logs.lines.slice(-400), '');
    $('#logCount').textContent = `${State.logs.lines.length} lines`;
  });
}

function followJob(jobId, { bar, phase, done, fail }) {
  const t = every(800, async () => {
    const job = await api(`/jobs/${jobId}`).catch(() => null);
    if (!job) return;
    if (bar) bar.style.width = `${job.percent || 0}%`;
    if (phase) phase.textContent = `${job.phase}${job.detail && typeof job.detail === 'string' ? ' · ' + job.detail : ''} — ${job.percent || 0}%`;
    if (job.state === 'done') { clearInterval(t); done && done(job); }
    if (job.state === 'failed') { clearInterval(t); fail && fail(job.error); }
  });
}

function wireDashboard() {
  if (!State.status.setup.installed) return wireSetupView();

  const btn = $('#stBtn');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api(`/sillytavern/${btn.dataset.act}`, { method: 'POST' });
      toast(btn.dataset.act === 'start' ? 'Starting SillyTavern…' : 'Stopped');
      setTimeout(refreshStatus, 1200);
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; }
  };
  const rb = $('#stRestart');
  if (rb) rb.onclick = async () => { rb.disabled = true; await api('/sillytavern/restart', { method: 'POST' }); toast('Restarting…'); setTimeout(refreshStatus, 1500); };

  const box = $('#dashLog');
  const pull = async () => {
    const r = await api('/logs?limit=120').catch(() => null);
    if (r) renderLogLines(box, r.lines.slice(-120), '');
  };
  pull(); every(3000, pull);

  api('/usage?days=1').then((u) => {
    const today = u.series[u.series.length - 1] || { requests: 0, tokens: 0 };
    const r = $('#todayReq'); const k = $('#todayTok');
    if (r) r.textContent = fmtNum(today.requests);
    if (k) k.textContent = `${fmtNum(today.tokens)} tokens`;
  }).catch(() => {});
}

function wireLogs() {
  const box = $('#logBox');
  const pull = async () => {
    const p = new URLSearchParams({ source: State.logs.source, level: State.logs.level, limit: '800' });
    if (State.logs.q) p.set('q', State.logs.q);
    const r = await api(`/logs?${p}`).catch(() => null);
    if (r) renderLogLines(box, r.lines, State.logs.q);
  };
  pull();
  const tick = () => { if (State.logs.live) pull(); };
  every(2000, tick);

  $('#logSource').onchange = (e) => { State.logs.source = e.target.value; pull(); };
  $('#logLevel').onchange = (e) => { State.logs.level = e.target.value; pull(); };
  $('#logSearch').oninput = (e) => { State.logs.q = e.target.value; clearTimeout(window._ls); window._ls = setTimeout(pull, 250); };
  $('#logLive').onchange = (e) => { State.logs.live = e.target.checked; };
}

function wireUsage() {
  if (!State.usage) return;
  const r = $('#usageReset');
  if (r) r.onclick = async () => {
    if (!confirm('Clear all local usage history? Charts will start from zero.')) return;
    await api('/usage/reset', { method: 'POST' });
    State.usage = await api('/usage'); render();
  };
}

function wireConfig() {
  if (!State.config) return;
  $('#cfgSave').onclick = async () => {
    const changes = {};
    document.querySelectorAll('[data-cfg]').forEach((i) => {
      changes[i.dataset.cfg] = i.type === 'checkbox' ? i.checked : i.value;
    });
    try {
      await api('/config', { method: 'POST', body: { changes } });
      toast('Saved. Restarting SillyTavern…', 'ok');
      await api('/sillytavern/restart', { method: 'POST' });
      State.config = await api('/config');
      render();
    } catch (err) { toast(err.message, 'bad'); }
  };

  $('#cfgRaw').onclick = () => {
    const c = State.config;
    openModal(`
      <h2>config.yaml</h2>
      <p style="color:var(--muted);font-size:12.5px;margin:6px 0 12px">${esc(c.path)}</p>
      <textarea id="rawYaml" rows="20">${esc(c.raw || '')}</textarea>
      <div class="row"><button data-close>Cancel</button><button class="primary" id="rawSave">Save</button></div>
    `, () => {
      $('#rawSave').onclick = async () => {
        try {
          await api('/config', { method: 'POST', body: { raw: $('#rawYaml').value } });
          toast('config.yaml saved', 'ok');
          closeModal();
          State.config = await api('/config'); render();
        } catch (err) { toast(err.message, 'bad'); }
      };
    });
  };
}

function wireSettings() {
  $('#setTunnelSave').onclick = async () => {
    await api('/tunnel', { method: 'POST', body: { enabled: $('#setTunnel').checked, webhookUrl: $('#setWebhook').value } });
    toast('Saved', 'ok'); refreshStatus();
  };
  $('#setTunnelRestart').onclick = async () => { await api('/tunnel/restart', { method: 'POST' }); toast('Reconnecting…'); };
  $('#setStSave').onclick = async () => {
    await api('/settings', { method: 'POST', body: { sillytavern: { autoStart: $('#setAutostart').checked, port: Number($('#setPort').value) } } });
    toast('Saved — restart SillyTavern to apply the port', 'ok');
  };
  $('#setPwSave').onclick = async () => {
    const pw = $('#setPw').value;
    try { await api('/settings', { method: 'POST', body: { password: pw } }); toast('Password changed', 'ok'); $('#setPw').value = ''; }
    catch (err) { toast(err.message, 'bad'); }
  };
  api('/versions').then((v) => {
    $('#setVersion').innerHTML = v.options.map((o) => `<option value="${esc(o.id)}" ${o.recommended ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  }).catch(() => { $('#setVersion').innerHTML = '<option value="latest">Latest release</option>'; });
  $('#setReinstall').onclick = async () => {
    if (!confirm('Install this version over the current one? Your data is not touched.')) return;
    const { jobId } = await api('/install', { method: 'POST', body: { version: $('#setVersion').value } });
    toast('Installing — watch progress in Logs');
    followJob(jobId, { done: () => { toast('Installed', 'ok'); refreshStatus(); }, fail: (e) => toast(e, 'bad') });
  };
}

function wireBackups() {
  const b = State.backups;
  if (!b) return;   // still loading; render() will run again with data

  document.querySelectorAll('input[name=profile]').forEach((r) => {
    r.onchange = () => saveBackupSettings({ profile: r.value });
  });
  $('#incSecrets').onchange = (e) => saveBackupSettings({ includeSecrets: e.target.checked });
  $('#bkInterval').onchange = (e) => saveBackupSettings({ intervalMinutes: Number(e.target.value) });
  $('#bkKeep').onchange = (e) => saveBackupSettings({ keepLocal: Number(e.target.value) });
  $('#bkShutdown').onchange = (e) => saveBackupSettings({ onShutdown: e.target.checked });

  $('#bkSave').onclick = () => saveBackupSettings({
    remote: {
      enabled: $('#r2on').checked,
      endpoint: $('#r2endpoint').value.trim(),
      bucket: $('#r2bucket').value.trim(),
      accessKeyId: $('#r2key').value.trim(),
      secretAccessKey: $('#r2secret').value,
      prefix: $('#r2prefix').value.trim(),
      keepRemote: Number($('#r2keep').value),
    },
  }, true);

  $('#r2test').onclick = async () => {
    const btn = $('#r2test'); btn.disabled = true; btn.textContent = 'Testing…';
    try {
      const r = await api('/backups/test-remote', {
        method: 'POST',
        body: { remote: {
          endpoint: $('#r2endpoint').value.trim(), bucket: $('#r2bucket').value.trim(),
          accessKeyId: $('#r2key').value.trim(), secretAccessKey: $('#r2secret').value,
        } },
      });
      toast(r.message, 'ok');
    } catch (err) { toast(err.message, 'bad'); }
    btn.disabled = false; btn.textContent = 'Test connection';
  };

  $('#bkNow').onclick = async () => {
    const profile = document.querySelector('input[name=profile]:checked')?.value;
    const { jobId } = await api('/backups/create', { method: 'POST', body: { profile } });
    showJobStrip('Backing up', jobId, async () => { await loadBackups(); render(); });
  };

  $('#bkUpload').onclick = () => $('#bkFile').click();
  $('#bkFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    toast(`Uploading ${f.name} (${fmtBytes(f.size)})…`);
    try {
      const r = await api(`/backups/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, raw: true });
      confirmRestore(r.file, 'local', r.info);
    } catch (err) { toast(err.message, 'bad'); }
  };

  document.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.onclick = async () => {
      let info = null;
      if (btn.dataset.from === 'local') {
        info = await api(`/backups/inspect?name=${encodeURIComponent(btn.dataset.restore)}`).catch(() => null);
      }
      confirmRestore(btn.dataset.restore, btn.dataset.from, info);
    };
  });

  document.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Delete ${btn.dataset.del}?`)) return;
      await api('/backups/delete', { method: 'POST', body: { name: btn.dataset.del } });
      await loadBackups(); render();
    };
  });
}

async function saveBackupSettings(patch, notify) {
  try {
    await api('/backups/settings', { method: 'POST', body: { settings: patch } });
    if (notify) toast('Backup settings saved', 'ok');
    await loadBackups();
  } catch (err) { toast(err.message, 'bad'); }
}

function confirmRestore(name, from, info) {
  openModal(`
    <h2>Restore ${esc(name)}</h2>
    ${info ? `<dl class="kv" style="margin:12px 0">
      <dt>Contents</dt><dd>${fmtNum(info.entries)} entries · ${fmtBytes(info.rawBytes)}</dd>
      <dt>Recognised</dt><dd>${info.recognised ? 'yes — SillyTavern user data' : 'NO'}</dd>
      <dt>API keys</dt><dd>${info.hasSecrets ? 'included (secrets.json)' : 'not included'}</dd>
      <dt>Top level</dt><dd style="font-size:11.5px">${esc((info.topLevel || []).slice(0, 12).join(', '))}</dd>
    </dl>` : ''}
    <div class="notice warn">A safety copy of your current data is taken first, so this is reversible.</div>
    <label class="switch"><input type="checkbox" id="wipeFirst"><span class="track"></span>
      <span class="txt"><b>Delete existing data first</b>
      <span>Off: the archive is merged over what is there. On: a clean replace.</span></span></label>
    <div class="row"><button data-close>Cancel</button><button class="primary" id="doRestore">Restore</button></div>
  `, () => {
    $('#doRestore').onclick = async () => {
      const wipe = $('#wipeFirst').checked;
      closeModal();
      const { jobId } = await api('/backups/restore', { method: 'POST', body: { name, from, wipe } });
      showJobStrip('Restoring', jobId, async () => { toast('Restore complete — SillyTavern restarted', 'ok'); await loadBackups(); render(); });
    };
  });
}

function showJobStrip(title, jobId, onDone) {
  const host = $('#bkJob') || $('#view');
  const strip = el(`<div class="card" style="margin-bottom:14px">
    <header><h2>${esc(title)}</h2><div class="spacer"></div><span class="eyebrow" id="jobPct">0%</span></header>
    <div class="bar"><i style="width:0%"></i></div>
    <p class="mono" style="font-size:12px;color:var(--muted);margin:9px 0 0" id="jobPhase">starting…</p></div>`);
  host.prepend(strip);
  followJob(jobId, {
    bar: $('.bar > i', strip),
    phase: $('#jobPhase', strip),
    done: async () => { strip.remove(); onDone && onDone(); },
    fail: (e) => { strip.remove(); toast(e, 'bad'); },
  });
  every(900, () => { const p = $('#jobPct', strip); const b = $('.bar > i', strip); if (p && b) p.textContent = b.style.width; });
}

// ── modal ────────────────────────────────────────────────────

function openModal(html, after) {
  closeModal();
  const scrim = el(`<div class="scrim"><div class="modal">${html}</div></div>`);
  scrim.onclick = (e) => { if (e.target === scrim || e.target.hasAttribute('data-close')) closeModal(); };
  document.body.appendChild(scrim);
  if (after) after();
}
function closeModal() { const s = $('.scrim'); if (s) s.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ── data loading ─────────────────────────────────────────────

async function loadBackups() {
  State.backups = await api('/backups');
  api('/backups/estimate').then((e) => { State.estimate = e.estimate; }).catch(() => {});
}

async function loadRouteData() {
  try {
    if (State.route === 'backups') { await loadBackups(); render(); }
    if (State.route === 'usage') { State.usage = await api('/usage'); render(); }
    if (State.route === 'config') { State.config = await api('/config'); render(); }
    if (State.route === 'settings') { State.settings = await api('/settings'); render(); }
  } catch (err) { toast(err.message, 'bad'); }
}

// ── boot ─────────────────────────────────────────────────────

async function boot() {
  const b = await api('/bootstrap');
  State.boot = b;
  State.booted = true;
  State.needsTerms = b.needsTerms;
  State.needsPassword = b.needsPassword;
  State.authenticated = b.authenticated && !b.needsPassword;
  State.installed = b.installed;

  if (State.authenticated) {
    State.status = await api('/status').catch(() => null);
    render();
    loadRouteData();
  } else {
    render();
  }
}

window.addEventListener('hashchange', () => {
  const r = location.hash.replace('#', '') || 'dashboard';
  if (r !== State.route) { State.route = r; render(); loadRouteData(); }
});

boot().catch((err) => {
  $('#app').innerHTML = `<div class="gate"><div class="gate-card">
    <h2>Cannot reach the manager</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin-top:8px">${esc(err.message)}</p>
    <button class="primary" style="margin-top:16px" onclick="location.reload()">Retry</button></div></div>`;
});
