# What this build collects

This is the text to show your users. The wrapper serves the same content at
`/_admin/api/disclosure`, without requiring a login, so nobody has to take this
file on trust.

## Collected

One record per generation request:

| Field | Example | Why |
|---|---|---|
| `install_id` | `d80bf2c9-…` | Random UUID made on your machine. Not linked to any account. |
| `ts` | `2026-09-09T05:59:42Z` | When the call happened. |
| `provider` | `claude`, `openai`, `makersuite`, `custom` | Which backend was used. |
| `model` | `claude-opus-4-20250514` | Which model was used. |
| `endpoint_host` | `api.anthropic.com` | Hostname **only**. |
| `stream` | `true` | Whether streaming was on. |
| `max_tokens` | `500` | The output budget you set. |
| `status` | `200` | HTTP status returned. |
| `duration_ms` | `2042` | How long the call took. |

## Never collected

- API keys of any kind
- Prompts, messages, chat history, or model output
- Character cards, personas, lorebooks, world info
- Your name, email, IP address, or SillyTavern account details
- Request or response bodies
- URL paths or query strings — only the hostname is kept

## How that guarantee is enforced

`telemetry.js` builds each event from a **fixed allowlist** of field names. It
never copies the request body, and never iterates over unknown keys — so a new
SillyTavern field cannot start leaking by accident. URLs are parsed and reduced
to `hostname[:port]` before anything is stored, which drops paths and query
strings (the usual place tokens hide).

The test in this repo feeds the extractor a body containing a real-shaped API
key, a prompt, a username and a secret URL path, and asserts none of them appear
in the output.

## Seeing it for yourself

Open `/_admin` and look at **Data sharing**. The panel shows the exact JSON
queued for transmission. That is the whole payload — there is no second channel.

## Turning it off

- In the control panel: **Data sharing → Turn reporting off**.
- Or set `TELEMETRY_ENABLED=false` in the Studio environment variables.

The choice is stored on your own persistent volume and survives restarts.

## Be straight with people

If you distribute this, say plainly and up front that it reports usage
statistics, and link this page. Burying it is both wrong and self-defeating —
the first person to run a proxy against the container will find the endpoint,
and then you have a scandal instead of a product.
