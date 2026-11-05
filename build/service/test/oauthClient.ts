/**
 * The official SDK client signing in with the Connect button, the way ChatGPT or Claude would:
 * discovery from the 401, registration, the browser part (here: plain requests), the owner's
 * Allow on the page, then the code exchange.
 */
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationContext,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import { pageHeaders } from "./helpers.js";

export class TestProvider implements OAuthClientProvider {
  creds = new Map<string, OAuthClientInformationMixed>();
  stored?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  lastState?: string;
  authUrl?: URL;

  constructor(
    readonly redirectUrl = "https://chatgpt.com/connector_platform_oauth_redirect",
    readonly clientMetadataUrl?: string,
    readonly name = "ChatGPT",
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: this.name, redirect_uris: [String(this.redirectUrl)], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation(ctx?: OAuthClientInformationContext) {
    return ctx ? this.creds.get(ctx.issuer) : undefined;
  }
  saveClientInformation(info: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext) {
    if (ctx) this.creds.set(ctx.issuer, info);
  }
  tokens() {
    return this.stored;
  }
  saveTokens(t: OAuthTokens) {
    this.stored = t;
  }
  state() {
    this.lastState = crypto.randomUUID();
    return this.lastState;
  }
  saveDiscoveryState(s: OAuthDiscoveryState) {
    this.discovery = s;
  }
  discoveryState() {
    return this.discovery;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("no code verifier");
    return this.verifier;
  }
}

export interface Started {
  provider: TestProvider;
  transport: StreamableHTTPClientTransport;
  /** /oauth/wait?r=... on the server the sign-in went to */
  waitUrl: string;
  secret: string;
}

/** Steps 1 and 2: the app connects, gets the 401, and opens the sign-in page. */
export async function startSignIn(mcpUrl: string, provider = new TestProvider()): Promise<Started> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(transport).then(
    () => {
      throw new Error("connected without signing in");
    },
    (e: unknown) => {
      if (!(e instanceof UnauthorizedError)) throw e;
    },
  );
  if (!provider.authUrl) throw new Error("no authorization URL");
  // the browser opens the authorization URL and lands on the waiting page
  const r = await fetch(provider.authUrl, { redirect: "manual" });
  if (r.status !== 303) throw new Error(`authorize: ${r.status} ${await r.text()}`);
  const waitUrl = new URL(r.headers.get("location")!, provider.authUrl).toString();
  const secret = new URL(waitUrl).searchParams.get("r")!;
  return { provider, transport, waitUrl, secret };
}

export async function waitStatus(started: Started): Promise<Record<string, unknown>> {
  const u = new URL(started.waitUrl);
  const r = await fetch(`${u.origin}/oauth/wait/status?r=${started.secret}`);
  return (await r.json()) as Record<string, unknown>;
}

/** The owner on the AI Connect page: Allow (or Don't allow) the first waiting sign-in. */
export async function decide(main: string, cookie: string, decision: "allow" | "deny"): Promise<string> {
  const state = (await (await fetch(`${main}/api/state`, { headers: { Cookie: cookie } })).json()) as { connects: Array<{ id: string }> };
  const id = state.connects[0]!.id;
  const r = await fetch(`${main}/api/connect/${id}`, { method: "POST", headers: { ...pageHeaders, Cookie: cookie }, body: JSON.stringify({ decision }) });
  if (r.status !== 200) throw new Error(`decide: ${r.status} ${await r.text()}`);
  return id;
}

/** Steps 3 to 5: the waiting page follows the decision; the app exchanges the code and connects. */
export async function finishSignIn(started: Started, mcpUrl: string): Promise<{ client: Client; callback: URL }> {
  const st = await waitStatus(started);
  if (typeof st.redirect !== "string") throw new Error(`not decided: ${JSON.stringify(st)}`);
  const callback = new URL(st.redirect);
  if (callback.searchParams.get("state") !== started.provider.lastState) throw new Error("state mismatch");
  await started.transport.finishAuth(callback.searchParams);
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: started.provider }));
  return { client, callback };
}
