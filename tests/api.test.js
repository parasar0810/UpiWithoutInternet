// HTTP API tests against a REAL PostgreSQL (DATABASE_URL). Skipped otherwise.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";

const skip = !process.env.DATABASE_URL && "DATABASE_URL not set (needs PostgreSQL)";
let pool, app;
before(async () => { if (!skip) { pool = createPool(); ({ app } = await createApp(pool, { rateLimitPerMin: 1000 })); } });
after(async () => { await pool?.end(); });

test("full offline → settlement flow over HTTP", { skip }, async () => {
  await request(app).post("/api/reset").expect(200);
  const created = await request(app).post("/api/payments").send({ sender: "alice@demo", receiver: "bob@demo", amountRupees: 250 }).expect(201);
  for (let i = 0; i < 3; i++) await request(app).post("/api/mesh/gossip").expect(200);
  const flush = await request(app).post("/api/mesh/flush").expect(200);
  const outcomes = flush.body.results.map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ["DUPLICATE_DROPPED", "SETTLED"]); // both bridges carried it; one wins
  const state = (await request(app).get("/api/state").expect(200)).body;
  assert.equal(state.simulation, true);
  assert.equal(state.ledger.accounts.find((a) => a.vpa === "alice@demo").balance_paise, 475_000);
  assert.equal(state.ledger.transactions[0].packet_hash, created.body.hash);
  assert.ok(state.mesh.devices.every((d) => !d.packets.some((p) => p.hash === created.body.hash)), "acknowledged packet removed from devices");
});

test("bridge offline: nothing settles until it reconnects", { skip }, async () => {
  await request(app).post("/api/reset").expect(200);
  for (const id of ["bridge-1", "bridge-2"]) await request(app).post(`/api/mesh/devices/${id}`).send({ online: false }).expect(200);
  await request(app).post("/api/payments").send({ sender: "alice@demo", receiver: "carol@demo", amountRupees: 10 }).expect(201);
  for (let i = 0; i < 4; i++) await request(app).post("/api/mesh/gossip");
  assert.equal((await request(app).post("/api/mesh/flush")).body.results.length, 0);
  await request(app).post("/api/mesh/devices/bridge-1").send({ online: true });
  for (let i = 0; i < 2; i++) await request(app).post("/api/mesh/gossip");
  assert.deepEqual((await request(app).post("/api/mesh/flush")).body.results.map((r) => r.outcome), ["SETTLED"]);
});

for (const [name, expected] of [["concurrent-duplicates", ["SETTLED", "DUPLICATE_DROPPED", "DUPLICATE_DROPPED", "DUPLICATE_DROPPED", "DUPLICATE_DROPPED"]], ["tampered", ["INVALID"]], ["replay", ["SETTLED", "DUPLICATE_DROPPED"]], ["expired", ["INVALID"]], ["forged-sender", ["INVALID"]], ["insufficient-balance", ["REJECTED"]]]) {
  test(`scenario: ${name}`, { skip }, async () => {
    await request(app).post("/api/reset");
    const r = await request(app).post(`/api/scenarios/${name}`).expect(200);
    assert.deepEqual([...r.body.outcomes].sort(), [...expected].sort());
  });
}

test("validation and errors", { skip }, async () => {
  await request(app).post("/api/payments").send({ sender: "alice@demo", receiver: "alice@demo", amountRupees: 1 }).expect(400);
  await request(app).post("/api/payments").send({ sender: "alice@demo", receiver: "bob@demo", amountRupees: -5 }).expect(400);
  await request(app).post("/api/payments").send({ sender: "eve@evil", receiver: "bob@demo", amountRupees: 5 }).expect(400);
  await request(app).post("/api/mesh/devices/nope").send({ online: false }).expect(404);
  await request(app).post("/api/scenarios/nope").expect(404);
  const bad = await request(app).post("/api/payments").set("Content-Type", "application/json").send("{bad json").expect(400);
  assert.equal(bad.body.error.code, "invalid_input");
  const res = await request(app).get("/api/server-key").expect(200);
  assert.match(res.body.publicKey, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify((await request(app).get("/api/state")).body), /PRIVATE KEY/);
});

test("rate limit applies to state-changing requests", { skip }, async () => {
  const { app: limited } = await createApp(pool, { rateLimitPerMin: 2 });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await request(limited).post("/api/mesh/gossip")).status);
  assert.deepEqual(codes, [200, 200, 429]);
  await request(limited).get("/api/health").expect(200);
});
