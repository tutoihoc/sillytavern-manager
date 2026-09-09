---
domain:
  - nlp
tags:
  - sillytavern
  - chat
license: AGPL-3.0
---

# SillyTavern on ModelScope

A private SillyTavern instance with automatic backups and a public link.

## Setup

1. Create a Studio, choose **Docker** as the SDK and the free CPU resource.
   Docker Studios require Alibaba Cloud real-name verification on your account.
2. Upload this `Dockerfile` and this `README.md` to the Studio repository.
3. Press **Launch** in Settings, then open **View Logs** and wait for the build.
4. In the runtime log, find the two lines you need:
   - `ADMIN PASSWORD (first boot): ...`
   - `tunnel URL: https://....trycloudflare.com`
5. Open the tunnel URL, create your SillyTavern account, and start chatting.
   The control panel is at `/_admin` on the same address.

## Environment variables

Set these under **Settings → Environment Variables**, then restart the Studio.
They are runtime-only; the image build cannot see them.

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Pin the control-panel password instead of the generated one. |
| `TUNNEL_WEBHOOK_URL` | Discord/Slack webhook. The new public URL is posted here on every wake. |
| `TUNNEL_ENABLED` | `false` to run only inside the ModelScope page, with no public link. |
| `R2_ENABLED` | `true` to turn on off-site backups to Cloudflare R2. |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | Your R2 bucket name. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token credentials. |
| `R2_INTERVAL_MIN` | Minutes between automatic backups (default 30). |
| `TELEMETRY_ENABLED` | `false` to switch usage reporting off. |

## Two links, and why you need both

- **The ModelScope Studio page** wakes the Studio up when it has gone to sleep.
- **The trycloudflare URL** is the nice direct link, but it is *dead* while the
  Studio sleeps, and it **changes every time the Studio wakes**.

So: if the tunnel link stops working, open the Studio page first, wait for it to
boot, then grab the fresh tunnel URL from the log, the control panel, or your
webhook.

## Your data

Chats, characters and settings live in `/mnt/workspace`, which survives restarts
and sleep. It does **not** survive renaming or transferring the Studio, and it is
gone if the Studio is deleted. Turn on R2 backups if the data matters to you, and
download a copy from the control panel now and then.

## What this reports back

This build sends anonymous usage counts to the person who published the image:
which provider and model each generation used, the endpoint hostname, the status
code and the duration.

It never sends API keys, prompts, chat logs, model output, character cards, or
your identity. Open `/_admin` to read the full disclosure, see the exact payload
queued for sending, and turn reporting off.
