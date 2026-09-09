# SillyTavern on ModelScope Studios

Research notes and a working deployment for running SillyTavern on a free
ModelScope Docker Studio, reachable through a Cloudflare quick tunnel, with
persistent data and a management wrapper.

Everything below marked **measured** was tested on this machine, not inferred
from documentation.

---

## 1. The platform constraints (from ModelScope's own docs)

| Constraint | Detail |
|---|---|
| Port | **7860 only.** "Port modification is currently not supported." Bind `0.0.0.0`. Any number of internal ports are fine; reverse-proxy them onto 7860. |
| Free resources | 2 vCPU / 16 GB RAM, CPU only. Sleeps when idle, wakes on access. |
| Persistence | **`/mnt/workspace` is a persistent volume.** Everything else is wiped on restart. |
| Build limits | `/mnt/workspace` is **not** mounted during `docker build`. Env vars are **not** available at build time (Docker Studios are in beta). |
| Eligibility | Docker Studios require **Alibaba Cloud account binding + real-name verification**. |
| Setup | SDK is chosen in the creation UI, not via `sdk:` in README. The README YAML is metadata only. |

The eligibility line is the one that will hurt your distribution plan — see §7.

## 2. Data persistence: solved

`/mnt/workspace` is exactly what you hoped it was. ModelScope's Docker Studio
doc states that data written there "will be retained after restarts", and warns
that it is still lost when the Studio is **renamed or transferred**.

**Measured:** built the image, ran it with a volume at `/mnt/workspace`, wrote a
marker file, destroyed the container completely, recreated it from the same
volume. The marker file, the SillyTavern user data, and the wrapper's install ID
all survived. First-boot seeding correctly did *not* re-run.

So the layout is:

```
/mnt/workspace/sillytavern/
├── data/        SillyTavern user data (SILLYTAVERN_DATAROOT)
├── config/      config.yaml           (symlinked to the app dir at runtime)
├── plugins/     server plugins        (symlinked)
├── extensions/  third-party UI extensions (symlinked)
├── _wrapper/    install id, consent, admin password
└── _backups/    local tar.gz snapshots
```

Because the volume dies with the Studio, R2 backup is the real disaster
recovery, not a nice-to-have. Cloudflare R2's free tier is **10 GB storage,
1M Class A + 10M Class B ops/month, free egress** — enormously more than a chat
archive needs.

## 3. The finding that decides the architecture

Cloudflare's docs say flatly: *"Quick Tunnels do not support Server-Sent Events
(SSE)."* Taken at face value that kills the project, because SillyTavern streams
tokens as `text/event-stream`.

**It is more specific than that.** Measured against a real trycloudflare tunnel,
repeated three times:

| Transport | Through a quick tunnel |
|---|---|
| **POST** + `text/event-stream` | **Streams incrementally** — chunks at 1.1s, 1.8s, 2.5s, 3.3s, 4.0s, 4.7s, 5.4s, 6.1s |
| **GET** + `text/event-stream` | **Buffered** — all 8 chunks arrive together at 6.1s, after the server closes |
| WebSocket | Streams incrementally |

SillyTavern's generation endpoints are `router.post('/generate', …)` in both
`src/endpoints/backends/chat-completions.js` and `text-completions.js`. It is
POST, so **streaming works**. This matches cloudflared issue #1449, which
describes the bug as specific to SSE over GET.

Consequences baked into the code:
- The wrapper's proxy pipes sockets directly and strips `accept-encoding`, so
  nothing can buffer the stream. **Measured** end-to-end: token chunks arrive at
  415/818/1223/1627/2027 ms through the wrapper.
- The admin UI **polls** and never uses `EventSource`, because that would be a
  GET SSE stream and would hang until close.

Remaining quick-tunnel limits you cannot engineer around: **200 concurrent
in-flight requests** (429 beyond that), and **no SLA**. Fine for personal use,
not for a service you promise uptime on.

## 4. Architecture

```
                    ┌─ ModelScope Studio page ──┐   (wakes the Studio)
internet ──────────►│                           │
                    └─ trycloudflare URL ───────┘   (dead while asleep)
                                 │
                                 ▼
                    :7860  wrapper (Node, no deps)
                       ├── /_admin  control panel
                       └── /*       ──► 127.0.0.1:8000  SillyTavern
                                            │
                                   /mnt/workspace  (persistent)
                                            │
                                   Cloudflare R2  (off-site backup)
```

One container, one port, no root-only tricks. `tini` reaps the SillyTavern and
cloudflared children.

## 5. What the wrapper does

- **Reverse proxy** on 7860 — streaming-safe, WebSocket passthrough.
- **Supervision** — restarts SillyTavern and cloudflared with backoff.
- **Persistence** — creates the layout, seeds image defaults on first boot only,
  and *verifies the volume is actually writable*, shouting if it is not.
- **Backup / restore** — tar.gz snapshots to the volume, optional R2 upload on a
  schedule, retention pruning, upload-and-restore from the browser, and a
  **safety snapshot taken before every restore**.
- **Usage metering** — provider, model, endpoint hostname, status, duration.
- **Disclosure UI** — shows the exact payload queued for sending, and a switch
  to turn reporting off.

### Verified behaviour

| Test | Result |
|---|---|
| Proxy passthrough | pass |
| Streaming preserved through wrapper | pass (1612 ms spread) |
| Generation metered | pass |
| No API key / prompt / path in telemetry | pass |
| Admin API rejects unauthenticated calls | pass (401) |
| Wrong password rejected | pass |
| Backup → corrupt data → restore | pass, original recovered |
| Safety snapshot before restore | pass |
| Telemetry reaches a real HTTP backend | pass, payload inspected |
| Persistence across container destroy/recreate | pass |
| Image builds and boots real SillyTavern | pass (960 MB) |

## 6. The sleep problem, and the two links

When the Studio sleeps, the container dies. That means:

1. The trycloudflare URL is **dead**, and hitting it will **not** wake the
   Studio — only the ModelScope Studio page does.
2. On wake, cloudflared mints a **brand new random hostname**.

There is no way around this on the free tier; a stable hostname requires a named
tunnel, which requires a Cloudflare account and a domain. The wrapper handles it
by posting the fresh URL to a webhook (`TUNNEL_WEBHOOK_URL`) on every start — a
Discord webhook works well. Users need both links, and need to understand the
Studio page is the "power button".

## 7. Two things worth knowing before you scale this

**Real-name verification.** Docker Studios are restricted to users who have
bound an Alibaba Cloud account and passed real-name verification. Your "anyone
can deploy this free in one click" plan runs into this on step one, and for
SillyTavern's typical use case, asking strangers to attach government ID to the
account hosting it is a meaningful ask. Verify this on the international
`modelscope.ai` before you build a funnel around it.

**Terms of service.** Using a free AI-demo hosting product as general-purpose
tunnelled app hosting is not what it is for, and a wave of identical Studios
running a Cloudflare tunnel is easy to spot. The realistic failure mode is that
the pattern gets blocked and every user's Studio dies at once. Do not build
anything you cannot afford to lose this way, and keep R2 backups on by default
so users can walk away with their data.

Neither of these is a reason not to proceed — they are reasons to keep the
migration path open.

## 8. Registry and "can people copy my image?"

You can absolutely publish to GHCR. On protecting it, the honest answer:

**A public image cannot be protected.** `docker pull` + `docker save` + `tar -x`
gets anyone every file, and `ENV`/`ARG` values are visible in the manifest. A
private image does not help either: the user's Dockerfile would need pull
credentials, and any credential you ship is a credential you gave away.

What actually works, in order:

1. **Keep the value on your server.** The container is a thin client; the
   analytics backend, licensing, and anything else you care about live behind an
   API you control and can revoke per install ID. Copying the image gets them a
   client that talks to a server that says no.
2. **Never put a secret in the image.** No keys, no tokens, no private endpoints.
   Assume the image is public even when it is not.
3. **Minify and bundle** (this repo does — esbuild, single file). That is a speed
   bump against casual copying, not protection. Do not confuse the two.

Also worth a five-minute smoke test before you commit: **confirm ModelScope's
builders can actually reach `ghcr.io`.** Their documented base image is an
Alibaba Cloud registry, and the `.cn` build infrastructure may not pull from
GitHub. If it cannot, mirror the image to Alibaba Cloud ACR and have the
template `FROM` that instead. This is the single highest-risk unknown left.

## 9. Layout

```
image/                    the image you build and push
├── Dockerfile            3-stage: bundle wrapper, fetch ST, runtime
├── entrypoint.sh         runtime symlinks (cannot be done at build time)
├── rootfs/defaults/      config.yaml seeded on first boot
└── wrapper/src/
    ├── index.js          entry: supervises ST, serves :7860
    ├── proxy.js          streaming-safe reverse proxy
    ├── telemetry.js      allowlist-based metering
    ├── storage.js        /mnt/workspace layout, seeding, write probe
    ├── backup.js         tar.gz snapshots + R2
    ├── s3.js             SigV4 signer (no AWS SDK)
    ├── tunnel.js         cloudflared supervisor + URL announce
    ├── admin.js          control-panel API
    └── ui.js             control-panel page

studio-template/          what your users push to ModelScope
├── Dockerfile            one FROM line
└── README.md             studio card + setup + disclosure

docs/PRIVACY.md           the disclosure text
```

## 10. Build and publish

```bash
docker build -t ghcr.io/OWNER/st-modelscope:0.1.0 ./image
docker push ghcr.io/OWNER/st-modelscope:0.1.0
```

Then point `studio-template/Dockerfile` at that tag and hand the template to
users. Pin a version tag; `:latest` means every user reboots into whatever you
pushed last.

Run it locally the way ModelScope does:

```bash
docker run --rm -p 7860:7860 -v st-ws:/mnt/workspace -e TUNNEL_ENABLED=false ghcr.io/OWNER/st-modelscope:0.1.0
```

## 11. Not done yet

- The analytics backend that receives the telemetry POST. The wrapper sends a
  documented JSON schema to `TELEMETRY_ENDPOINT`; nothing listens yet.
- Verifying ghcr.io reachability from ModelScope's builders (§8).
- Confirming real-name verification requirements on `modelscope.ai` (§7).
- A first-run consent screen shown *before* SillyTavern loads, if you want
  opt-in rather than disclosed opt-out.

## 12. Live deployment (verified end to end)

Deployed for real on 2026-09-09 to `tutoihoc/sillytavern`, a free ModelScope
Docker Studio, building from GitHub, reachable over a Cloudflare quick tunnel.

| Question | Answer |
|---|---|
| Can ModelScope's builders reach github.com? | **Yes.** The image clones SillyTavern and this repo during the Studio build, and installs cloudflared from GitHub releases. This was the biggest unknown in section 8; it is resolved. |
| Does `/mnt/workspace` really persist? | **Yes.** Across a full redeploy the wrapper logged the *same* install id (`2fdc9508-...`) and did not re-seed config - the volume survived. |
| Does the quick tunnel work from inside a Studio? | **Yes.** cloudflared connects and SillyTavern loads fully over the public trycloudflare URL. |
| Is 7860 really the only port? | Yes, and the Studio UI hard-codes it: the port field is disabled, labelled "Docker mode port is fixed to 7860". |

### Two things that bit us

**SillyTavern's `hostWhitelist.enabled` cannot be set from an environment
variable.** In `src/middleware/hostWhitelist.js`:

```js
const hostWhitelistEnabled = !!getConfigValue('hostWhitelist.enabled', false);        // no converter
const hostWhitelistScan  = !!getConfigValue('hostWhitelist.scan', false, 'boolean');  // converter
```

Env values arrive as **strings**, and `!!"false"` is `true`. So setting
`SILLYTAVERN_HOSTWHITELIST_ENABLED=false` *enables* the whitelist and every
request gets a 403. Only keys whose call site passes `'boolean'` can be set to
false from the environment. Leave that key alone, or set it in `config.yaml`.

The wrapper now also presents `Host: 127.0.0.1:<port>` upstream (keeping the
original in `X-Forwarded-Host`), so SillyTavern sees a loopback client and the
whitelist is a non-issue regardless of how it is configured.

**Platform log capture starts late.** ModelScope's run log missed the container's
first few seconds on the initial deploy, swallowing the generated admin password,
which the wrapper only printed once. It now prints on every boot and again 30s in.

### Studio quotas

A ModelScope account is limited to a small number of Studios (5 on this
account); creating past it fails with `create too many studios`. Worth knowing
before telling users "just make a new Studio".
