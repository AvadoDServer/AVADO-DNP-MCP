# AVADO AI Connect

`mcp.avado.dnp.dappnode.eth` ("AI Connect"): an [MCP](https://modelcontextprotocol.io) server on the
AVADO box, so owners can connect their own AI assistants (Claude Code, Claude Desktop, ChatGPT,
Codex, Cursor, others) to their box. The assistant can check the box and explain it in plain
language; the owner decides, per assistant, whether it may also restart, install or update apps.

The page at http://mcp.my.ava.do (also https) is where the owner makes and removes keys, gets
copy-paste steps for each assistant, approves actions and sees everything the assistants did.

## Endpoints (AVADO network only; no host ports)

| Port | What |
|---|---|
| 80 | Page, page API (`/api/*`) and MCP endpoint `/mcp`: `http://mcp.my.ava.do/mcp` |
| 443 | The same over HTTPS with the `*.my.ava.do` certificate: `https://mcp.my.ava.do/mcp` |
| 8000 | MCP endpoint **only** (`/mcp`, `/k/<key>/mcp`); no page, no key management. The Tailscale package forwards here, so a public Tailscale Funnel address can never reach the key page. |

MCP transport: Streamable HTTP (protocol 2025-11-25 and older, via `@modelcontextprotocol/sdk`
1.32.2), stateless, JSON responses. `GET`/`DELETE` on `/mcp` answer 405.

The certificate is taken from the DAPPMANAGER's copy (`http://dappmanager.my.ava.do/my.ava.do.crt`,
as AVADO-DNP-Nethermind does), else `http://iso.ava.do`, checked (`*.my.ava.do`, key matches, not
expiring) and cached in the volume; renewed daily. AVADO publishes that key for every box, so HTTPS
here only protects against passive listening; every request also needs a key.

## Tools

| Tool | Scope | What |
|---|---|---|
| `box_overview` | read | System version, OS, uptime, CPU, memory, disk, temperatures, apps running |
| `list_apps` | read | Installed apps: version, running, system part, auto-update, data size, page |
| `health_check` | read | The Admin's own health rules (vendored, same set as AVADO Care) + processes down / out of memory / restarting (DAPPMANAGER `getDiagnostics`, 10.0.53+) |
| `app_logs` | read | Newest lines of one app's log (≤ 500 lines, ≤ 48 kB), secrets hidden |
| `ethereum_status` | read | Per node app: reachable, syncing, distance, peers, version, validator **count** |
| `store_apps` | read | The box's AVADO store (production or staging, as rpc.ava.do says), installed/update flags |
| `action_status` | read | Progress of installs/updates started here |
| `restart_app` | restart | Restart one installed app (never system parts, never AI Connect itself) |
| `install_app` | install | Install a store app by name, default settings, store manifest hash only |
| `update_app` | install | Update an installed app to the store version |

**Never possible** (enforced in `src/dappmanager.ts`, an allow-list of 9 DAPPMANAGER procedures,
and tested in `test/never.test.ts`): validator keystores or passwords, slashing protection,
withdrawal or fee-recipient changes (fee recipients are not even read), wallet seeds/mnemonics,
Rocket Pool or other wallets, the Admin password, env values (stripped from every app listing),
IP addresses or the node id, any docker/shell command, file copies, removing apps or volumes,
resets, reboots, core (system) installs/updates/restarts, installs by IPFS hash or URL.

## Keys

- One key per assistant, made on the page; shown once; only its SHA-256 is stored
  (`/data/tokens.json`, mode 600). 256 random bits, prefix `avado_`.
- Scopes: `read` (always), `restart`, `install` (install + update).
- "Ask me first" (default on): an action waits up to 2 minutes for Allow / Don't allow on the
  page; no answer means it is not done.
- Sent as `Authorization: Bearer <key>`, or inside the address (`/k/<key>/mcp`) for apps that only
  take an address (ChatGPT, Claude on the web).
- Limits: 120 MCP requests/min per key, 10 actions/hour per key, 20 wrong keys per 5 min per
  client address (then 429).
- Activity log (`/data/activity.json`, newest 500): every tool call, refused calls (also calls to
  tools outside the key's scopes), wrong keys, approvals, key changes.

## Page API (same-origin only)

Host allow-list (DNS rebinding) and `X-Avado-Request: 1` + Origin/Referer/Sec-Fetch-Site checks on
every `/api/*` request (same rules as AVADO Care). `GET /api/state`, `POST /api/tokens`,
`POST /api/tokens/<id>/revoke`, `POST /api/tokens/<id>/confirm`, `POST /api/approvals/<id>`.
`/mcp` refuses requests with a foreign `Origin` header (MCP spec).

## Reaching it

- On the AVADO network (AVADO Remote Access/ZeroTier or AVADO WiFi): `https://mcp.my.ava.do/mcp`.
- Through the Tailscale package (`AVADO-DNP-Tailscale`): `https://<box>.<tailnet>.ts.net/mcp`
  (Tailscale Serve, owner's devices only), optionally public via Tailscale Funnel for ChatGPT and
  Claude on the web. Funnel exposes only the MCP door (port 8000 through the Tailscale package's
  relay, which itself passes only `/mcp` paths); a key is still needed.

## Health rules

`vendor/admin` holds byte-for-byte copies of the Admin's health rules, the **same files and Admin
commit as AVADO Care 0.1.2** (`vendor/admin/VENDORED.json`); `scripts/` are Care's vendoring
scripts. Re-vendor with `ADMIN_SRC=/path/to/DNP_ADMIN/build/src/src yarn vendor:sync` (the newer
Admin rules ipfs/lostData/mevboost/processes need more vendored files and snapshot inputs).

## Build and test

```
cd build/service && yarn install --frozen-lockfile && yarn lint && yarn test   # Node 22
docker buildx build --platform linux/amd64 --load -f build/Dockerfile -t mcp.avado.dnp.dappnode.eth:0.1.0 .
```

The image build runs the type check and the whole test suite (scope enforcement, the never-list,
redaction, keys, and a real MCP SDK client against the server).
