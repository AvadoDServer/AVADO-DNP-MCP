# AVADO AI Connect

`mcp.avado.dnp.dappnode.eth` ("AI Connect"): an [MCP](https://modelcontextprotocol.io) server on the
AVADO box, so owners can connect their own AI assistants (Claude Code, Claude Desktop, ChatGPT,
Codex, Cursor, others) to their box. The assistant can check the box and explain it in plain
language. Changing anything (restart, install or update apps) needs the page's **Allow changes**
switch (off by default) and, per assistant, that permission.

The page at http://mcp.my.ava.do (also https) is where the owner connects assistants (ChatGPT and
Claude on the web with the app's **Connect** button and an Allow on this page; the others with a
key and copy-paste steps), approves actions, switches changes on or off and sees everything the
assistants did, changes in plain sentences. All of that is behind a **page PIN** the owner chooses
the first time the page is opened (see below). Assistants never need the PIN.

## Endpoints (AVADO network only; no host ports)

| Port | What |
|---|---|
| 80 | Page, page API (`/api/*`) and MCP endpoint `/mcp`: `http://mcp.my.ava.do/mcp` |
| 443 | The same over HTTPS with the `*.my.ava.do` certificate: `https://mcp.my.ava.do/mcp` |
| 8000 | MCP endpoint **only** (`/mcp`, `/k/<key>/mcp`) and its sign-in (`/.well-known/oauth-*`, `/oauth/*`, see below); no page, no key management, no approvals. The Tailscale package forwards here, so a public Tailscale Funnel address can never reach the page. |

MCP transport: Streamable HTTP with the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`
2.4.0 and `@modelcontextprotocol/node` 2.1.2; protocol 2026-07-28, and 2025-era clients through
the SDK's stateless legacy path), a fresh server per request, JSON responses only. `GET`/`DELETE`
on `/mcp` answer 405.

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
| `validate_package` | read | For developers: checks a package's `dappnode_package.json` (and `docker-compose.yml`) offline against AVADO's rules and says in plain words what the package would get on a box (privileged, host network, box folders, ports). Touches nothing. Borrowed from DAppNode's `dappnode_validate_package` (see below) |
| `restart_app` | restart | Restart one installed app (never system parts, never AI Connect itself) |
| `install_app` | install | Install a store app by name, default settings, store manifest hash only |
| `update_app` | install | Update an installed app to the store version |

The last three change the box. They work only while **Allow changes** is on (`src/settings.ts`,
`/data/settings.json`, off on a new box). While it is off they are not listed to assistants at all
(as DAppNode's MCP server hides its mutating tools until the owner enables them), and a call
anyway is refused and logged. Switching changes off also declines every action that waits for an
OK, and an action the owner allowed is checked against the switch once more before it runs. Every
change attempt is logged as one plain sentence ("Claude Code restarted Teku.", "ChatGPT wanted to
install Nimbus. Not done: changes are switched off."), shown under the switch on the page.

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
  take an address (offered only under "Other"; ChatGPT and Claude on the web use the Connect button).
- Limits: 120 MCP requests/min per key, 10 actions/hour per key, 20 wrong keys per 5 min per
  client address (then 429).
- Activity log (`/data/activity.json`, newest 500): every tool call, refused calls (also calls to
  tools outside the key's scopes), wrong keys, approvals, key changes, PIN chosen / wrong / reset.

## Connect button: sign-in with OAuth (`src/oauth.ts`)

For ChatGPT, Claude on the web and any MCP client that signs in by itself: no key to copy. The
owner adds the AI Connect address in the app and presses **Connect**; the app opens a page
"Approve on your AVADO" with a 4-digit code; the AI Connect page (PIN) shows "ChatGPT wants to
connect", the same code and where it goes back to, with **Allow** / **Don't allow**; the waiting
page then sends the browser back to the app. It follows the MCP authorization spec (2026-07-28):

- AI Connect is its own authorization server. Protected resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource[/mcp]`, authorization server metadata (RFC 8414) at
  `/.well-known/oauth-authorization-server`; a 401 from `/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata="…", scope="avado"`.
- Apps register with a Client ID Metadata Document (the spec's preferred way: an https
  `client_id` whose JSON is fetched, checked to name itself, cached an hour; never from private or
  AVADO-network addresses, no redirects, 10 kB max) or Dynamic Client Registration (RFC 7591,
  `/oauth/register`; public clients, or a client secret when the app asks for one).
- Authorization code flow, PKCE S256 only; redirect URIs https or localhost (exact match; a
  localhost port may change, RFC 8252); `iss` in every answer (RFC 9207); the `resource`
  parameter (RFC 8707) binds every token to one MCP address, and `/mcp` refuses tokens for another
  (a token from `https://mcp.my.ava.do/mcp` does not work on the Tailscale address and back).
  Tokens only in the `Authorization` header, never in the address.
- Access tokens 1 hour (memory only), refresh tokens rotated on every use (the previous one
  works 2 more minutes for a retry; a connection unused for 90 days must connect again). A code
  works once, 10 minutes; a reused code removes the connection made with it.
- Nothing is allowed by visiting a link: the approval is a button on the PIN page. At most 5
  sign-ins wait at once (10 minutes each, the oldest gives way), 60 sign-in requests per 10
  minutes per listener. Apps on localhost get an extra warning on the card (anything on that
  computer could have started it), as the spec asks.
- A connection made this way is listed with the others ("connected with the Connect button, goes
  back to chatgpt.com"), may look and, while Allow changes is on, restart/install/update with "Ask
  me first" on; connecting the same app again replaces its old connection. Removing it, or a PIN
  reset, signs it out at once. Waiting sign-ins are declined by a reset.
- On the Tailscale address the sign-in works the same way: the Tailscale package's relay (0.2.0)
  passes these paths on and tells AI Connect the box's Tailscale name (`X-Forwarded-Host`), which
  becomes the issuer there. The waiting page is reachable from the internet; the page with Allow
  never is.
- Stored: registered apps in `/data/oauth.json`; connections in `/data/tokens.json`.

## validate_package and DAppNode

DAppNode's MCP server (dappnode/DNP_DAPPMANAGER, `packages/dappmanager/src/mcp/tools.ts`, GPL-3.0
like this package) has `dappnode_validate_package` and a set of upload / install-dev-package tools.
`validate_package` takes the validate tool's idea and shape (raw files in, every problem in one
list, run it on every iteration); DAppNode checks with `@dappnode/schemas`, which describe
DAppNode's current package format, so the AVADO rules follow AVADO's own DAPPMANAGER generator
(`build/src/src/utils/generate.js`: the container comes from the manifest's `image` section), the
store and the Admin's `setupWizard`. The upload and install-dev tools were not taken: AVADO's
DAPPMANAGER has no install-without-the-store call, and AI Connect promises owners that assistants
only ever install apps from the AVADO store (any package may ask for privileged mode or the Docker
socket, so one click would hand over the whole box).

## Page PIN (`src/pin.ts`)

- First open: the page asks for a PIN (6 to 12 digits; all-same digits and rows like 123456 are
  refused). Until it is set, and whenever the page is locked, `GET /api/state` returns only the
  version, HTTPS and Tailscale status, the PIN state and the **number** of waiting actions: no
  connections, activity, waiting actions or jobs.
- Needs the PIN: making and removing keys (so also granting `restart` or `install`), the
  "ask me first" setting, the Allow changes switch, Allow / Don't allow (actions and Connect
  sign-ins), and reading the activity list.
- Stored as scrypt (Node's built-in `crypto.scrypt`, no native module; N=2^15, r=8, p=1, 16-byte
  salt) in `/data/pin.json` (mode 600).
- Session: a random 256-bit cookie `aic_session` (only its SHA-256 kept, in memory, so a restart
  locks the page), `HttpOnly; SameSite=Strict; Path=/api`, `Secure` over HTTPS; ends 10 minutes
  after the last click or 30 minutes after the PIN at most (the page's own 5-second refresh does
  not keep it alive). "Lock the page" ends it at once. CSRF checks still apply to every PIN route.
- Wrong PINs, per device: 5 tries, then a wait of 1 minute that doubles up to 15 minutes ("Too
  many wrong PINs from this device. Try again in 4 minutes."). A device is the address the
  connection comes from. X-Forwarded-For counts only from a trusted proxy, and none is trusted on
  an AVADO: ZeroTier Remote Access, the AVADO Wi-Fi and Tailscale pass connections on at the
  network level without that header, each under its own address on the AVADO network. So all
  devices that come in through one of them share one count, but a guesser on one way in (or an
  app on the box) cannot lock the owner out of the others.
- Wrong PINs, whole box: after more than 20 wrong PINs in an hour, every try from any device
  waits 3 seconds before it is checked (the page says so). Slower guessing from many addresses;
  the page is never closed.
- Both counts are kept in `pin.json` (a restart does not help a guesser). Tries from one device
  are checked one at a time, at most two PIN hashes run at once; each wrong PIN is listed in the
  activity.
- Forgot PIN: the owner presses **Restart** for AI Connect in the AVADO Admin and comes back within
  10 minutes; the page then offers "Reset the PIN". The reset removes **every key** (and declines
  waiting actions), so whoever resets the PIN gets an empty AI Connect, never the owner's
  assistants. The window opens only after an Admin restart: the DAPPMANAGER's `restartPackage`
  makes a new container (`compose rm` + `up`), which is told apart by a marker file in the
  container's own files (`/tmp/ai-connect-container`) plus the last version in the volume
  (`/data/last-version`). A reboot, power cut, crash or Pause/Start keeps the old container, and an
  update brings a new version, so neither opens it. Once per start. Removing AI Connect with its
  data and installing it again also starts from scratch.
- No PIN means no keys: at start, a `pin.json` that cannot be read, or keys left without a PIN (a
  reset that could not save the empty key list, e.g. on a full disk), removes every key (the page
  then asks for a new PIN).
- Known limit: until the owner chooses the PIN, any device on the AVADO network can choose it
  first (the owner would then see "Enter your PIN" and use the reset). Same first-open model as
  other AVADO app pages.

## Page API (same-origin only)

Host allow-list (DNS rebinding) and `X-Avado-Request: 1` + Origin/Referer/Sec-Fetch-Site checks on
every `/api/*` request (same rules as AVADO Care). Without a session: `GET /api/state` (reduced
while locked), `POST /api/pin/set`, `/api/pin/unlock`, `/api/pin/lock`, `/api/pin/reset`. With
the PIN session: `POST /api/tokens`, `POST /api/tokens/<id>/revoke`,
`POST /api/tokens/<id>/confirm`, `POST /api/approvals/<id>`, `POST /api/connect/<id>` (a Connect
sign-in), `POST /api/settings` (`{"allowChanges": true|false}`) (otherwise 401).
`/mcp` refuses requests with a foreign `Origin` header (MCP spec).

## Reaching it

- On the AVADO network (AVADO Remote Access/ZeroTier or AVADO WiFi): `https://mcp.my.ava.do/mcp`.
- Through the Tailscale package (`AVADO-DNP-Tailscale`): `https://<box>.<tailnet>.ts.net/mcp`
  (Tailscale Serve, owner's devices only), optionally public via Tailscale Funnel for ChatGPT and
  Claude on the web. Funnel exposes only the MCP door (port 8000 through the Tailscale package's
  relay, which itself passes only `/mcp` paths and the sign-in paths); a key or an app the owner
  allowed is still needed.

## Health rules

`vendor/admin` holds byte-for-byte copies of the Admin's health rules, the **same files and Admin
commit as AVADO Care 0.1.2** (`vendor/admin/VENDORED.json`); `scripts/` are Care's vendoring
scripts. Re-vendor with `ADMIN_SRC=/path/to/DNP_ADMIN/build/src/src yarn vendor:sync` (the newer
Admin rules ipfs/lostData/mevboost/processes need more vendored files and snapshot inputs).

## Build and test

```
cd build/service && yarn install --frozen-lockfile && yarn lint && yarn test   # Node 22
docker buildx build --platform linux/amd64 --load -f build/Dockerfile -t mcp.avado.dnp.dappnode.eth:0.2.0 .
```

The image build runs the type check and the whole test suite (scope enforcement, the never-list,
redaction, keys, the page PIN, the Allow changes switch, validate_package, and the official MCP
SDK v2 client against the server, including the whole Connect sign-in with registration, Client ID
Metadata Documents, PKCE, resource binding and refresh rotation).

## Store

Category hint in the manifest: `"avadocategory": "thelab"` (The Lab). The category the store
shows is the one set for the package in the store editor; set it to The Lab there too. The Lab is
hidden in the Admin's Simple mode store (owners find it by search or with Advanced mode).
