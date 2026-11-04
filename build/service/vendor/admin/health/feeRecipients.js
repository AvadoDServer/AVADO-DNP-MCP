// Fee recipients of the validator keys loaded in each validator client, read
// through the standard keymanager API that every AVADO validator package
// serves at :9999/keymanager (the package adds its keymanager token server
// side). The same routes are used by the Rocket Pool backend and
// AVADO-Client-UI.
//
// Result per validator package that could be read:
//   { validators, checked, missing }
// A checked key counts as `missing` when
//  - its client says in so many words that none is set: a 404/500 whose
//    message names the fee recipient (Lighthouse "no fee recipient set",
//    Teku "Fee recipient not found"), and the key is still loaded when the
//    key list is read again (Teku gives the same answer for a key deleted in
//    between); or
//  - its fee recipient is the zero address AND the beacon node has that
//    validator active (or exited/slashed): Nimbus answers the zero address
//    for a validator that is not in the chain state yet (0x01 credentials, no
//    default fee recipient) although it will use the withdrawal address once
//    the validator is active. Pending, unknown or unreadable → not counted.
// A bare 404 is ambiguous (unknown key, route missing on an old client) and
// makes the whole client "unknown". A client that cannot be read (not
// running, no answer, an unexpected reply) is left out entirely, so the rule
// never raises a finding on data it could not see. Only whether an address
// is set is looked at; no address or pubkey leaves this module.
//
// In the browser (the Admin) none of these clients can be read today: the
// :9999 servers of Nimbus and Lighthouse (oak CORS list) and the Teku and
// Prysm monitors (restify CORS list) only allow http://<name>.my.ava.do and
// localhost origins, not http://my.ava.do (checked on the test box: the
// answer carries `access-control-allow-origin: false`), and the beacon APIs
// send no CORS headers. So the Admin makes no request at all
// (`browser: true`) instead of logging a CORS error every few minutes.
// AVADO Care reads them server side, where CORS does not apply.

export const VALIDATOR_CLIENTS = [
  { name: "nimbus.avado.dnp.dappnode.eth", keymanager: "http://nimbus.my.ava.do:9999/keymanager", beacon: "http://nimbus.my.ava.do:5052", browserReadable: false },
  { name: "teku.avado.dnp.dappnode.eth", keymanager: "http://teku.my.ava.do:9999/keymanager", beacon: "http://teku.my.ava.do:5051", browserReadable: false },
  { name: "lighthouse.avado.dnp.dappnode.eth", keymanager: "http://lighthouse.my.ava.do:9999/keymanager", beacon: "http://lighthouse.my.ava.do:5052", browserReadable: false },
  // Prysm: the validator client and its keys live in the eth2validator package,
  // the beacon node in prysm-beacon-chain-mainnet
  {
    name: "eth2validator.avado.dnp.dappnode.eth",
    keymanager: "http://eth2validator.my.ava.do:9999/keymanager",
    beacon: "http://prysm-beacon-chain-mainnet.my.ava.do:3500",
    browserReadable: false,
  },
];

// At most this many keys are checked per client on each run (also the size of
// the one batched beacon-node lookup), so a box with hundreds of validators
// does not fire hundreds of requests at once.
export const MAX_KEYS_CHECKED = 64;
const TIMEOUT_MS = 10000;
const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const PUBKEY = /^0x[0-9a-f]{96}$/i;
const SAYS_NOT_SET = /fee.?recipient|suggested/i;
// On the chain and able to propose (or recently so): a zero fee recipient matters.
const ON_CHAIN = /^(active|exited)_/;

async function getJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function listKeys(fetchImpl, client) {
  const list = await getJson(fetchImpl, `${client.keymanager}/eth/v1/keystores`);
  if (list.status !== 200 || !list.body || !Array.isArray(list.body.data)) return null;
  const pubkeys = list.body.data
    .map(k => k && (k.validating_pubkey || k.pubkey))
    .filter(pk => typeof pk === "string" && PUBKEY.test(pk))
    .map(pk => pk.toLowerCase());
  return pubkeys.length === list.body.data.length ? pubkeys : null; // unexpected shape: don't guess
}

/** Pubkeys (lowercase) the beacon node has active or exited; null when it can't be read. */
async function onChainKeys(fetchImpl, client, pubkeys) {
  try {
    const r = await getJson(fetchImpl, `${client.beacon}/eth/v1/beacon/states/head/validators?id=${pubkeys.join(",")}`);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.data)) return null;
    const out = new Set();
    for (const v of r.body.data) {
      const pk = v && v.validator && typeof v.validator.pubkey === "string" ? v.validator.pubkey.toLowerCase() : null;
      if (pk && typeof v.status === "string" && ON_CHAIN.test(v.status)) out.add(pk);
    }
    return out;
  } catch (e) {
    return null;
  }
}

/** One client: { validators, checked, missing }, or null when it cannot be read. */
export async function readClientFeeRecipients(client, fetchImpl = fetch) {
  try {
    const pubkeys = await listKeys(fetchImpl, client);
    if (!pubkeys) return null;
    const sample = pubkeys.slice(0, MAX_KEYS_CHECKED);
    const notSet = [];
    const zero = [];
    for (const pk of sample) {
      const r = await getJson(fetchImpl, `${client.keymanager}/eth/v1/validator/${pk}/feerecipient`);
      const message = r.body && typeof r.body.message === "string" ? r.body.message : "";
      if ((r.status === 404 || r.status === 500) && SAYS_NOT_SET.test(message)) {
        notSet.push(pk);
        continue;
      }
      const address = r.status === 200 && r.body && r.body.data ? r.body.data.ethaddress : undefined;
      if (typeof address !== "string" || !ADDRESS.test(address)) return null; // an error or an odd reply: unknown
      if (ZERO_ADDRESS.test(address)) zero.push(pk);
    }
    let missing = 0;
    if (notSet.length) {
      // a key deleted between the list and its fee-recipient read is not "missing"
      const again = await listKeys(fetchImpl, client);
      if (!again) return null;
      const still = new Set(again);
      missing += notSet.filter(pk => still.has(pk)).length;
    }
    if (zero.length) {
      // one batched lookup; unreadable → none of the zero answers count
      const onChain = await onChainKeys(fetchImpl, client, zero);
      if (onChain) missing += zero.filter(pk => onChain.has(pk)).length;
    }
    return { validators: pubkeys.length, checked: sample.length, missing };
  } catch (e) {
    return null;
  }
}

/**
 * Reads every installed, running validator client. Returns an object keyed by
 * package name, with the clients that could not be read left out; null when
 * no validator client runs, or when none of the running ones could be read
 * (so the rule is skipped, not counted as passed).
 *
 * `browser: true` (the Admin) reads only clients a page on http://my.ava.do
 * can reach (none today, see the top of this file).
 */
export async function fetchFeeRecipients(packages, fetchImpl = fetch, { browser = false } = {}) {
  const running = new Set((packages || []).filter(p => p && p.running).map(p => p.name));
  const clients = VALIDATOR_CLIENTS.filter(c => running.has(c.name) && (!browser || c.browserReadable));
  if (!clients.length) return null;
  const out = {};
  for (const client of clients) {
    const r = await readClientFeeRecipients(client, fetchImpl);
    if (r) out[client.name] = r;
  }
  return Object.keys(out).length ? out : null;
}
