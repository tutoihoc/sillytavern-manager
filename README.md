# SillyTavern Manager

One place to install, run, expose and back up [SillyTavern](https://github.com/SillyTavern/SillyTavern)
— on a PC, a phone, a VPS or a free cloud Studio. No terminal required after the
first command.

- **Install in one click.** Pick a version from the official releases; the
  manager downloads it, installs dependencies and starts it.
- **A public link.** A Cloudflare quick tunnel, so SillyTavern opens on your
  phone without port forwarding or a domain.
- **Backups that actually restore.** Archives are the same format as
  SillyTavern's own *Download Backup*, so files move freely in both directions.
  Optional off-site copies to Cloudflare R2 or any S3-compatible storage.
- **Logs in the browser.** Everything SillyTavern prints, searchable, without a
  terminal.
- **A config editor.** Turn on a password, change ports, set a proxy — without
  hand-editing YAML (though you can do that too, and your comments survive).
- **Usage charts.** Which models you use, how many tokens, how often.

---

## Install

Node.js 18.17 or newer is the only requirement.

```bash
npm install -g sillytavern-manager
stm
```

Then open **http://localhost:7860/manager** and follow the setup.

### Android (Termux)

```bash
pkg install nodejs-lts
npm install -g sillytavern-manager
stm
```

Everything is pure JavaScript, so nothing needs compiling. `cloudflared` is
downloaded automatically for `linux-arm64`.

### Docker / VPS

```bash
docker build -t sillytavern-manager -f deploy/docker/Dockerfile .
docker run -d --name stm -p 7860:7860 -v stm-data:/data sillytavern-manager
```

### ModelScope (free Studio)

Upload [`deploy/modelscope/Dockerfile`](deploy/modelscope/Dockerfile) and a
`README.md` to a Studio repository, choose **Docker** as the SDK, press Launch.
`STM_HOME` is set to `/mnt/workspace`, the only directory a Studio keeps across
restarts.

---

## Claiming a new install

Until a panel password is set, an unconfigured manager will not hand itself to
whoever finds the URL first. You prove ownership one of two ways:

- **Open it on the machine itself** (`http://localhost:7860/manager`), or
- **Enter the setup code** printed in the log on every boot until a password
  exists. On ModelScope that is *Settings -> View log -> Run log*; look for
  `SETUP CODE:`. A fresh one is issued every restart.

The second path exists because hosts like ModelScope give you no reachable
localhost — the log is the only channel that proves you are the owner.

A note on why "local" is checked the way it is: behind a Cloudflare tunnel every
request reaches the manager from `127.0.0.1`, because cloudflared connects over
loopback. So a request counts as local only when the peer is loopback **and**
carries no forwarding header (`x-forwarded-for`, `cf-connecting-ip`, `cf-ray`,
…). Getting this wrong hands the panel to the internet, and it is covered by a
regression test.

Forgot the password on a headless host? Set `STM_RESET_PASSWORD` to any new
value and restart. It clears the password once, records the value, and ignores
the variable on later boots — so it is safe to leave in place.

The panel password is separate from SillyTavern's own login. If you publish the
tunnel link, turn on basic auth or user accounts under **Config** as well — the
panel warns you when SillyTavern has no password of its own.

## Where your data lives

| Platform | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\SillyTavernManager` |
| Linux / VPS | `~/.local/share/sillytavern-manager` |
| Termux | `$PREFIX/var/sillytavern-manager` |
| ModelScope | `/mnt/workspace/sillytavern-manager` |
| Docker | `/data` (mount a volume) |

Override with `STM_HOME`. The dashboard states plainly whether that location
survives a restart, and says so loudly when it does not.

Both SillyTavern data layouts are handled: `data/<user>/` (1.12 and newer) and
the legacy `public/` layout, detected automatically and never rearranged.

---

## Backups

Two profiles, sized on your actual data before you commit:

| Profile | What it holds |
|---|---|
| **Everything** | Characters, chats, worlds, extensions, settings |
| **Chats and settings only** | Conversations, worlds and configuration — skips character cards, usually most of the weight |

Always excluded because they are rebuilt or duplicated: `thumbnails/`,
`vectors/`, SillyTavern's own `backups/`, `.git` and `node_modules`. On a real
2.36 GB export that pruning alone removed 570 MB and 6,566 files.

`secrets.json` holds your API keys and is **excluded by default**. Turn it on
for local backups you want to restore verbatim; think twice before sending it to
cloud storage.

**Scheduling.** A run that finds nothing changed is skipped — a fingerprint of
file count, total size and newest mtime is compared first, so a quiet day costs
no bandwidth. On shutdown the manager takes a quick chats-only snapshot with a
timeout, because a multi-gigabyte archive cannot finish inside a shutdown grace
period. Uploads over 64 MB use multipart, so a dropped connection does not
restart a 2 GB transfer.

**Sizing for R2's free tier:** 10 GB. At 2.4 GB per full backup, three copies is
already 7.2 GB — the panel does this arithmetic for you next to the retention
setting.

---

## What is reported

This build reports anonymous usage. That is the arrangement for a free tool, and
the first-run screen says so in three lines.

**Sent:** an anonymous install ID, your platform, and per generation the
provider, model, endpoint *hostname*, token counts, status code and duration.

**Never sent:** API keys, prompts, messages, model output, character cards,
personas, lorebooks, file names, URL paths or query strings, IP addresses, or
account names.

This is enforced by construction, not by policy: `src/core/telemetry.js` builds
each event field by field from a fixed allowlist and never copies a request
object, so a new SillyTavern field cannot start leaking by accident. URLs are
reduced to `hostname[:port]` before storage, which drops the paths and query
strings where tokens hide.

Open **Usage** to see the exact JSON queued for sending. There is no second
channel.

The collection endpoint is configurable with `STM_TELEMETRY_ENDPOINT`; the
server contract is documented at the top of `src/core/telemetry.js`.

---

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | Panel and proxy port (default 7860) |
| `STM_HOME` | Where everything is stored |
| `CLOUDFLARED_BIN` | Use an existing cloudflared instead of downloading one |
| `STM_TELEMETRY_ENDPOINT` | Usage reporting endpoint |
| `STM_RESET_PASSWORD` | Set to a new value to clear the panel password once on next start |

```
stm                 start the manager
stm status          where things live, and whether they persist
stm reset-password  forget the panel password
stm --port 8080     use a different port
```

---

## How it fits together

```
                    ┌── phone / laptop ─── trycloudflare URL ──┐
                    │                                          │
  browser ──────────┴─────────────► :7860 manager ─────────────┤
                                      ├── /manager  control panel
                                      └── /*        SillyTavern (127.0.0.1:8000)
                                                        │
                                              data + backups on disk
                                                        │
                                              S3 / Cloudflare R2
```

SillyTavern is served at `/` rather than under a path prefix, because it is a
single-page app with absolute asset paths. That also means one port and one
tunnel URL cover both the app and the panel — the only shape that works on
ModelScope, where 7860 is the only port there is.

**Streaming.** Token streaming survives the whole chain. Cloudflare quick
tunnels buffer `GET` server-sent events but stream `POST` ones, and
SillyTavern's generation endpoints are POST — so streaming works, while the
panel's own live views poll instead of using `EventSource`. Measurements are in
[`docs/research/FINDINGS.md`](docs/research/FINDINGS.md).

---

## Known limits

- A Cloudflare quick tunnel gets a **new random hostname every restart** and
  caps at **200 concurrent requests**, with no uptime guarantee. Set a webhook
  under Settings to be told the new URL automatically.
- On ModelScope the Studio sleeps when idle. The tunnel dies with it, and
  opening the tunnel URL will **not** wake it — only the Studio page does.
- macOS downloads no `cloudflared` (Cloudflare ships it only as a tarball);
  install it with `brew install cloudflared` and set `CLOUDFLARED_BIN`.

## License

AGPL-3.0-or-later. Note what that does and does not do: it requires anyone who
modifies this and runs it as a network service to publish their source. It does
not stop someone stripping the usage reporting — no license can. Only a
server-side check can do that.
