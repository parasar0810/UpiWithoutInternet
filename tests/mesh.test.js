import assert from "node:assert/strict";
import { test } from "node:test";
import { generateServerKeys } from "../src/crypto.js";
import { Mesh } from "../src/mesh.js";

const server = generateServerKeys();
const holders = (m, hash) => m.state().devices.filter((d) => d.packets.some((p) => p.hash === hash)).map((d) => d.id).sort();

test("payment starts on the sender's phone only", () => {
  const m = new Mesh(server.publicKey);
  const { hash, device } = m.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 100 });
  assert.equal(device, "alice-phone");
  assert.deepEqual(holders(m, hash), ["alice-phone"]);
});

test("gossip moves a packet one hop per round and decrements TTL", () => {
  const m = new Mesh(server.publicKey);
  const { hash } = m.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 100 });
  m.gossip();
  assert.deepEqual(holders(m, hash), ["alice-phone", "bob-phone", "relay-1"]);
  m.gossip();
  const s = m.state();
  assert.ok(holders(m, hash).includes("relay-2") && holders(m, hash).includes("carol-phone"));
  assert.equal(s.devices.find((d) => d.id === "relay-2").packets[0].ttl, 3);
  assert.ok(!holders(m, hash).includes("bridge-1")); // two hops from alice is not enough
  m.gossip();
  assert.ok(holders(m, hash).includes("bridge-1") && holders(m, hash).includes("bridge-2"));
});

test("offline devices neither receive nor forward (store-and-forward resumes later)", () => {
  const m = new Mesh(server.publicKey);
  const { hash } = m.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 100 });
  m.setOnline("alice-phone", false);
  m.gossip();
  assert.deepEqual(holders(m, hash), ["alice-phone"]);
  m.setOnline("alice-phone", true);
  m.gossip();
  assert.equal(holders(m, hash).length, 3);
});

test("partitions block propagation", () => {
  const m = new Mesh(server.publicKey);
  const { hash } = m.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 100 });
  m.setPartition("alice-phone", "B");
  for (let i = 0; i < 4; i++) m.gossip();
  assert.deepEqual(holders(m, hash), ["alice-phone"]);
});

test("TTL limits reach", () => {
  const m = new Mesh(server.publicKey);
  const { hash } = m.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 100 });
  for (let i = 0; i < 10; i++) m.gossip();
  for (const d of m.state().devices) for (const p of d.packets.filter((x) => x.hash === hash)) assert.ok(p.ttl >= 0 && p.hops <= 5);
});

test("devices de-duplicate by ciphertext hash; tampering creates a different hash", () => {
  const m = new Mesh(server.publicKey);
  const { hash } = m.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 100 });
  m.gossip(); m.gossip();
  const bob = m.state().devices.find((d) => d.id === "bob-phone");
  assert.equal(bob.packets.filter((p) => p.hash === hash).length, 1);
  const bad = m.tamper("alice-phone", hash);
  assert.notEqual(bad, hash);
});

test("unknown device and demo caps are reported", () => {
  const m = new Mesh(server.publicKey);
  assert.throws(() => m.setOnline("nope", false), /Unknown device/);
  assert.throws(() => m.setPartition("relay-1", "Z"), /Partition/);
  assert.throws(() => m.createPayment({ sender: "dave@demo", receiver: "bob@demo", amountPaise: 1 }), /No phone/);
});
