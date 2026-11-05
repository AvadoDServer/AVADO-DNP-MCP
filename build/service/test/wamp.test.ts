import assert from "node:assert/strict";
import { test } from "node:test";
import { WampClient, WampError, type WebSocketLike } from "../src/wamp.js";

/** A scripted router: answers HELLO with WELCOME and hands every other message to `onSend`. */
class MockSocket implements WebSocketLike {
  static last: MockSocket | null = null;
  readyState = 0;
  sent: unknown[][] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  static onSend: (sock: MockSocket, msg: unknown[]) => void = () => {};

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockSocket.last = this;
    setImmediate(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string): void {
    const msg = JSON.parse(data) as unknown[];
    this.sent.push(msg);
    if (msg[0] === 1) this.push([2, 123, {}]);
    else MockSocket.onSend(this, msg);
  }
  push(msg: unknown[]): void {
    setImmediate(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
  close(): void {
    this.readyState = 3;
    setImmediate(() => this.onclose?.({}));
  }
}

const client = () => new WampClient({ url: "ws://wamp.test/ws", realm: "dappnode_admin", WebSocket: MockSocket, callTimeoutMs: 500, connectTimeoutMs: 500 });

test("call sends HELLO with the realm and returns the first positional result", async () => {
  MockSocket.onSend = (sock, msg) => {
    if (msg[0] === 48) sock.push([50, msg[1], {}, [`result of ${msg[3]}`]]);
  };
  const c = client();
  const r = await c.call("listPackages.dappmanager.dnp.dappnode.eth", [], { a: 1 });
  assert.equal(r, "result of listPackages.dappmanager.dnp.dappnode.eth");
  const hello = MockSocket.last!.sent[0]!;
  assert.equal(hello[0], 1);
  assert.equal(hello[1], "dappnode_admin");
  assert.deepEqual(MockSocket.last!.protocols, ["wamp.2.json"]);
  const call = MockSocket.last!.sent[1]!;
  assert.deepEqual(call.slice(2), [{}, "listPackages.dappmanager.dnp.dappnode.eth", [], { a: 1 }]);
  c.close();
});

test("an ERROR for a missing procedure is 'unavailable', other errors are 'rejected'", async () => {
  MockSocket.onSend = (sock, msg) => {
    if (msg[0] !== 48) return;
    const uri = msg[3] === "missing" ? "wamp.error.no_such_procedure" : "app.error";
    sock.push([8, 48, msg[1], {}, uri, ["boom"]]);
  };
  const c = client();
  await assert.rejects(c.call("missing"), (e: unknown) => e instanceof WampError && e.kind === "unavailable");
  await assert.rejects(c.call("other"), (e: unknown) => e instanceof WampError && e.kind === "rejected" && /boom/.test(e.message));
  c.close();
});

test("subscribe waits for SUBSCRIBED and delivers EVENT args", async () => {
  MockSocket.onSend = (sock, msg) => {
    if (msg[0] === 32) {
      sock.push([33, msg[1], 777]);
      sock.push([36, 777, 1, {}, [[{ name: "Geth", syncing: false }]]]);
    }
  };
  const c = client();
  const got = new Promise<unknown[]>((resolve) => {
    void c.subscribe("chainData.dappmanager.dnp.dappnode.eth", (args) => resolve(args));
  });
  assert.deepEqual(await got, [[{ name: "Geth", syncing: false }]]);
  assert.deepEqual(MockSocket.last!.sent[1]!.slice(2), [{}, "chainData.dappmanager.dnp.dappnode.eth"]);
  c.close();
});

test("a call without an answer times out", async () => {
  MockSocket.onSend = () => {};
  const c = client();
  await assert.rejects(c.call("slow", [], {}, 50), (e: unknown) => e instanceof WampError && e.kind === "timeout");
  c.close();
});

test("a router that never answers HELLO times out the connection", async () => {
  class Silent extends MockSocket {
    override send(data: string): void {
      this.sent.push(JSON.parse(data) as unknown[]);
    }
  }
  const c = new WampClient({ url: "ws://x", realm: "r", WebSocket: Silent, connectTimeoutMs: 50 });
  await assert.rejects(c.call("x"), (e: unknown) => e instanceof WampError && e.kind === "timeout");
  // later calls on the same client fail at once instead of waiting for another timeout
  const started = Date.now();
  await assert.rejects(c.call("y"), (e: unknown) => e instanceof WampError);
  assert.ok(Date.now() - started < 40);
  c.close();
});
