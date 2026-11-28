// HTTP API tests against a REAL PostgreSQL (DATABASE_URL). Skipped otherwise.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";

const skip = !process.env.DATABASE_URL && "DATABASE_URL not set (needs PostgreSQL)";
let pool, app, server;
const closers = [];
before(async () => {
  if (skip) return;
  pool = createPool();
  ({ app: server } = await make({ rateLimitPerMin: 1000 }));
  app = request.agent(server); // keeps the sandbox cookie, like a browser
});
after(async () => { closers.forEach((c) => c()); await pool?.end(); });
async function make(opts) { const r = await createApp(pool, opts); closers.push(r.close); return r; }

test("full offline → settlement flow over HTTP", { skip }, async () => {
  await app.post("/api/reset").expect(200);
  const created = await app.post("/api/payments").send({ sender: "alice@demo", receiver: "bob@demo", amountRupees: 250 }).expect(201);
  for (let i = 0; i < 3; i++) await app.post("/api/mesh/gossip").expect(200);
  const flush = await app.post("/api/mesh/flush").expect(200);
  const outcomes = flush.body.results.map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ["DUPLICATE_DROPPED", "SETTLED"]); // both bridges carried it; one wins
  const state = (await app.get("/api/state").expect(200)).body;
  assert.equal(state.simulation, true);
  assert.equal(state.ledger.accounts.find((a) => a.vpa === "alice@demo").balance_paise, 475_000);
  assert.equal(state.ledger.transactions[0].packet_hash, created.body.hash);
  assert.ok(state.mesh.devices.every((d) => !d.packets.some((p) => p.hash === created.body.hash)), "acknowledged packet removed from devices");
});

test("bridge offline: nothing settles until it reconnects", { skip }, async () => {
  await app.post("/api/reset").expect(200);
  for (const id of ["bridge-1", "bridge-2"]) await app.post(`/api/mesh/devices/${id}`).send({ online: false }).expect(200);
  await app.post("/api/payments").send({ sender: "alice@demo", receiver: "carol@demo", amountRupees: 10 }).expect(201);
  for (let i = 0; i < 4; i++) await app.post("/api/mesh/gossip");
  assert.equal((await app.post("/api/mesh/flush")).body.results.length, 0);
  await app.post("/api/mesh/devices/bridge-1").send({ online: true });
  for (let i = 0; i < 2; i++) await app.post("/api/mesh/gossip");
  assert.deepEqual((await app.post("/api/mesh/flush")).body.results.map((r) => r.outcome), ["SETTLED"]);
});

for (const [name, expected] of [["concurrent-duplicates", ["SETTLED", "DUPLICATE_DROPPED", "DUPLICATE_DROPPED", "DUPLICATE_DROPPED", "DUPLICATE_DROPPED"]], ["tampered", ["INVALID"]], ["replay", ["SETTLED", "DUPLICATE_DROPPED"]], ["expired", ["INVALID"]], ["forged-sender", ["INVALID"]], ["insufficient-balance", ["REJECTED"]]]) {
  test(`scenario: ${name}`, { skip }, async () => {
    await app.post("/api/reset");
    const r = await app.post(`/api/scenarios/${name}`).expect(200);
    assert.deepEqual([...r.body.outcomes].sort(), [...expected].sort());
  });
}

test("validation and errors", { skip }, async () => {
  await app.post("/api/payments").send({ sender: "alice@demo", receiver: "alice@demo", amountRupees: 1 }).expect(400);
  await app.post("/api/payments").send({ sender: "alice@demo", receiver: "bob@demo", amountRupees: -5 }).expect(400);
  await app.post("/api/payments").send({ sender: "eve@evil", receiver: "bob@demo", amountRupees: 5 }).expect(400);
  await app.post("/api/mesh/devices/nope").send({ online: false }).expect(404);
  await app.post("/api/scenarios/nope").expect(404);
  const bad = await app.post("/api/payments").set("Content-Type", "application/json").send("{bad json").expect(400);
  assert.equal(bad.body.error.code, "invalid_input");
  const res = await app.get("/api/server-key").expect(200);
  assert.match(res.body.publicKey, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify((await app.get("/api/state")).body), /PRIVATE KEY/);
});

test("rate limit applies to state-changing requests", { skip }, async () => {
  const limited = request.agent((await make({ rateLimitPerMin: 2 })).app);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await limited.post("/api/mesh/gossip")).status);
  assert.deepEqual(codes, [200, 200, 429]);
  await limited.get("/api/health").expect(200);
});

// ---- Per-visitor isolation -------------------------------------------------------------
const alice = (st) => st.ledger.accounts.find((a) => a.vpa === "alice@demo").balance_paise;
async function settle(agent, amountRupees) {
  await agent.post("/api/payments").send({ sender: "alice@demo", receiver: "bob@demo", amountRupees }).expect(201);
  for (let i = 0; i < 3; i++) await agent.post("/api/mesh/gossip").expect(200);
  return (await agent.post("/api/mesh/flush").expect(200)).body.results.map((r) => r.outcome).sort();
}

test("two visitors get separate sandboxes: payments, settlement and reset never cross", { skip }, async () => {
  const { app: srv } = await make({ rateLimitPerMin: 1000 });
  const a = request.agent(srv), b = request.agent(srv);
  const first = await a.get("/api/state").expect(200);
  const cookie = first.headers["set-cookie"].join(";");
  assert.match(cookie, /upi_sandbox=[0-9a-f-]{36}/);
  assert.match(cookie, /HttpOnly/i);
  assert.equal(first.body.sandbox.isolated, true);

  assert.deepEqual(await settle(a, 1000), ["DUPLICATE_DROPPED", "SETTLED"]);
  const sb = (await b.get("/api/state")).body;
  assert.equal(alice(sb), 500_000, "B's ledger is untouched by A's settlement");
  assert.equal(sb.ledger.transactions.length, 0);
  assert.ok(sb.mesh.devices.every((d) => d.packets.length === 0), "B's phones never saw A's packet");
  assert.ok(!sb.mesh.events.some((e) => e.type === "created"), "B's event log has none of A's actions");

  await b.post("/api/mesh/devices/bridge-1").send({ online: false }).expect(200);
  await b.post("/api/reset").expect(200);
  const sa = (await a.get("/api/state")).body;
  assert.equal(alice(sa), 400_000, "A keeps its balance after B resets");
  assert.ok(sa.mesh.devices.find((d) => d.id === "bridge-1").online, "B's device change didn't reach A");
});

test("a forged or malformed sandbox cookie gets a fresh sandbox, not someone else's", { skip }, async () => {
  const { app: srv } = await make({ rateLimitPerMin: 1000 });
  const a = request.agent(srv);
  await settle(a, 100);
  const r = await request(srv).get("/api/state").set("Cookie", "upi_sandbox=../../etc; other=1").expect(200);
  assert.equal(alice(r.body), 500_000);
  assert.doesNotMatch(r.headers["set-cookie"].join(";"), /etc/);
});

test("sandboxes are capped: the least recently used one is evicted and its rows deleted", { skip }, async () => {
  const { app: srv, sandboxes } = await make({ rateLimitPerMin: 1000, maxSandboxes: 2 });
  const [a, b, c] = [request.agent(srv), request.agent(srv), request.agent(srv)];
  await settle(a, 100);
  await b.get("/api/state");
  const idA = [...sandboxes.keys()][0];
  await c.get("/api/state"); // evicts A
  assert.equal(sandboxes.size, 2);
  assert.ok(!sandboxes.has(idA));
  const rows = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE sandbox = $1", [idA]);
  assert.equal(rows.rows[0].n, 0, "evicted sandbox rows removed from PostgreSQL");
  assert.equal(alice((await a.get("/api/state")).body), 500_000, "A returns to a fresh sandbox");
});

test("idle sandboxes expire and their rows are removed", { skip }, async () => {
  const { app: srv, sandboxes } = await make({ rateLimitPerMin: 1000, sandboxTtlMs: 100 });
  const a = request.agent(srv);
  await a.get("/api/state");
  const id = [...sandboxes.keys()][0];
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(!sandboxes.has(id));
  const rows = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE sandbox = $1", [id]);
  assert.equal(rows.rows[0].n, 0);
});

test("behind Render, the rate-limit key is the client IP that Cloudflare appended, not a proxy", { skip }, async () => {
  const { app: srv } = await make({ rateLimitPerMin: 2, trustProxy: true, proxyHops: 3 });
  const hit = (client, edge) => request(srv).post("/api/mesh/gossip").set("X-Forwarded-For", `${client}, ${edge}, 10.28.0.12`);
  assert.deepEqual([(await hit("203.0.113.9", "104.23.1.71")).status, (await hit("203.0.113.9", "172.68.0.5")).status, (await hit("203.0.113.9", "104.23.1.71")).status], [200, 200, 429]);
  assert.equal((await hit("198.51.100.7", "104.23.1.71")).status, 200, "another client sharing the same edge has its own budget");
});

test("the rate limit follows a visitor's sandbox across IP changes", { skip }, async () => {
  const { app: srv } = await make({ rateLimitPerMin: 2, trustProxy: true, proxyHops: 3 });
  const agent = request.agent(srv);
  await agent.get("/api/state");
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await agent.post("/api/mesh/gossip").set("X-Forwarded-For", `198.51.100.${i}, 104.23.1.71, 10.28.0.12`)).status);
  assert.deepEqual(codes, [200, 200, 429]);
});
