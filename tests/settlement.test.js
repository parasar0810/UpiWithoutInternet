// Settlement tests against a REAL PostgreSQL (set DATABASE_URL). Skipped otherwise.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { generateServerKeys } from "../src/crypto.js";
import { createPool, ledger, migrate, seed } from "../src/db.js";
import { ACCOUNTS, Mesh } from "../src/mesh.js";
import { OUTCOME, ingest } from "../src/settlement.js";

const skip = !process.env.DATABASE_URL && "DATABASE_URL not set (needs PostgreSQL)";
let pool, server, mesh;

before(async () => {
  if (skip) return;
  pool = createPool();
  server = generateServerKeys();
  mesh = new Mesh(server.publicKey);
  await migrate(pool);
});
beforeEach(async () => { if (!skip) { mesh.reset(); await seed(pool, ACCOUNTS, mesh.publicKeys()); } });
after(async () => { await pool?.end(); });

const pay = (opts = {}) => {
  const { device, hash } = mesh.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 10_000, ...opts });
  return mesh.device(device).held.get(hash);
};
const balances = async () => Object.fromEntries((await ledger(pool)).accounts.map((a) => [a.vpa, a.balance_paise]));

test("valid packet settles once: debit + credit + ledger row", { skip }, async () => {
  const r = await ingest(pool, server.privateKey, pay(), { bridgeNode: "bridge-1" });
  assert.equal(r.outcome, OUTCOME.SETTLED);
  const b = await balances();
  assert.equal(b["alice@demo"], 490_000);
  assert.equal(b["bob@demo"], 210_000);
  assert.equal((await ledger(pool)).transactions.length, 1);
});

test("20 concurrent deliveries of one packet settle exactly once", { skip }, async () => {
  const p = pay();
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => ingest(pool, server.privateKey, p, { bridgeNode: `b${i}` })));
  assert.equal(outcomes.filter((o) => o.outcome === OUTCOME.SETTLED).length, 1);
  assert.equal(outcomes.filter((o) => o.outcome === OUTCOME.DUPLICATE).length, 19);
  assert.equal((await balances())["alice@demo"], 490_000);
});

test("total money is conserved under concurrent, opposite transfers", { skip }, async () => {
  const before = (await ledger(pool)).totalPaise;
  const packets = [];
  for (let i = 0; i < 10; i++) {
    packets.push(pay({ amountPaise: 1_000 }));
    packets.push(pay({ sender: "bob@demo", receiver: "alice@demo", amountPaise: 700 }));
  }
  const results = await Promise.all(packets.map((p) => ingest(pool, server.privateKey, p)));
  assert.ok(results.every((r) => r.outcome === OUTCOME.SETTLED), JSON.stringify(results.map((r) => r.reason)));
  assert.equal((await ledger(pool)).totalPaise, before);
  const b = await balances();
  assert.equal(b["alice@demo"], 500_000 - 10 * 1_000 + 10 * 700);
});

test("tampered ciphertext is INVALID and moves no money", { skip }, async () => {
  const p = pay();
  const buf = Buffer.from(p.ciphertext, "base64");
  buf[buf.length - 3] ^= 1;
  const r = await ingest(pool, server.privateKey, { ciphertext: buf.toString("base64") });
  assert.equal(r.outcome, OUTCOME.INVALID);
  assert.equal(r.reason, "decryption_failed");
  assert.equal((await balances())["alice@demo"], 500_000);
});

test("replay of a settled packet is a duplicate", { skip }, async () => {
  const p = pay();
  assert.equal((await ingest(pool, server.privateKey, p)).outcome, OUTCOME.SETTLED);
  assert.equal((await ingest(pool, server.privateKey, p)).outcome, OUTCOME.DUPLICATE);
});

test("re-encrypted replay (same signed payment, new ciphertext) is caught by the unique nonce", { skip }, async () => {
  const { encryptForServer, decryptAtServer } = await import("../src/crypto.js");
  const p = pay();
  await ingest(pool, server.privateKey, p);
  const envelope = decryptAtServer(p.ciphertext, server.privateKey); // attacker would need the plaintext; worst case
  const r = await ingest(pool, server.privateKey, { ciphertext: encryptForServer(envelope, server.publicKey) });
  assert.equal(r.outcome, OUTCOME.INVALID);
  assert.equal(r.reason, "replayed_nonce");
  assert.equal((await balances())["alice@demo"], 490_000);
});

test("expired and future-dated payments are INVALID", { skip }, async () => {
  assert.equal((await ingest(pool, server.privateKey, pay({ signedAt: Date.now() - 25 * 3_600_000 }))).reason, "stale_packet");
  assert.equal((await ingest(pool, server.privateKey, pay({ signedAt: Date.now() + 3_600_000 }))).reason, "future_dated");
});

test("payment signed by another device is rejected (sender authentication)", { skip }, async () => {
  const r = await ingest(pool, server.privateKey, pay({ signWith: "carol@demo" }));
  assert.equal(r.outcome, OUTCOME.INVALID);
  assert.equal(r.reason, "bad_signature");
});

test("insufficient balance is recorded as REJECTED without moving money", { skip }, async () => {
  const r = await ingest(pool, server.privateKey, pay({ sender: "carol@demo", amountPaise: 9_000_000 }));
  assert.equal(r.outcome, OUTCOME.REJECTED);
  const b = await balances();
  assert.equal(b["carol@demo"], 100_000);
  assert.equal((await ledger(pool)).transactions[0].status, "REJECTED");
});

test("concurrent overdraft attempts never make a balance negative", { skip }, async () => {
  // Carol has ₹1,000; ten simultaneous ₹300 payments → at most 3 can settle.
  const packets = Array.from({ length: 10 }, () => pay({ sender: "carol@demo", amountPaise: 30_000 }));
  const results = await Promise.all(packets.map((p) => ingest(pool, server.privateKey, p)));
  assert.equal(results.filter((r) => r.outcome === OUTCOME.SETTLED).length, 3);
  assert.equal((await balances())["carol@demo"], 10_000);
});

test("a failed settlement releases the idempotency claim so the packet can be retried", { skip }, async () => {
  const p = pay();
  // A pool whose connection fails on the balance update; the patch is removed before the
  // connection goes back to the real pool so later tests are unaffected.
  const broken = {
    connect: async () => {
      const c = await pool.connect();
      const query = c.query, release = c.release;
      c.query = (sql, ...a) => (/^UPDATE accounts/.test(sql) ? Promise.reject(new Error("simulated DB failure")) : query.call(c, sql, ...a));
      c.release = (...a) => { c.query = query; c.release = release; return release.apply(c, a); };
      return c;
    },
  };
  await assert.rejects(ingest(broken, server.privateKey, p), /simulated DB failure/);
  assert.equal((await ingest(pool, server.privateKey, p)).outcome, OUTCOME.SETTLED);
});

test("malformed packets are INVALID", { skip }, async () => {
  assert.equal((await ingest(pool, server.privateKey, {})).reason, "malformed_packet");
  assert.equal((await ingest(pool, server.privateKey, { ciphertext: "AAAA" })).reason, "decryption_failed");
});
