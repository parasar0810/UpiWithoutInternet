import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { DecryptionError, decryptAtServer, encryptForServer, exportPublicPem, generateDeviceKeys, generateServerKeys, signPayment, verifyPayment } from "../src/crypto.js";

const server = generateServerKeys();
const alice = generateDeviceKeys();
const payment = { sender: "alice@demo", receiver: "bob@demo", amountPaise: 50_000, nonce: crypto.randomUUID(), signedAt: Date.now() };

test("hybrid encryption round-trips", () => {
  const ct = encryptForServer({ payment, signature: "x" }, server.publicKey);
  assert.deepEqual(decryptAtServer(ct, server.privateKey).payment, payment);
});

test("same payload encrypts differently each time (fresh AES key + IV)", () => {
  assert.notEqual(encryptForServer({ payment }, server.publicKey), encryptForServer({ payment }, server.publicKey));
});

test("any flipped bit is rejected by the GCM tag", () => {
  const buf = Buffer.from(encryptForServer({ payment }, server.publicKey), "base64");
  for (const pos of [10, 300, buf.length - 1]) {
    const t = Buffer.from(buf);
    t[pos] ^= 1;
    assert.throws(() => decryptAtServer(t.toString("base64"), server.privateKey), DecryptionError);
  }
});

test("only the server's private key can decrypt", () => {
  const other = generateServerKeys();
  assert.throws(() => decryptAtServer(encryptForServer({ payment }, server.publicKey), other.privateKey), DecryptionError);
});

test("Ed25519 signature authenticates the sender and covers every field", () => {
  const sig = signPayment(payment, alice.privateKey);
  const pem = exportPublicPem(alice.publicKey);
  assert.equal(verifyPayment(payment, sig, pem), true);
  for (const change of [{ amountPaise: 50_001 }, { receiver: "carol@demo" }, { nonce: crypto.randomUUID() }, { signedAt: payment.signedAt + 1 }]) {
    assert.equal(verifyPayment({ ...payment, ...change }, sig, pem), false);
  }
  assert.equal(verifyPayment(payment, signPayment(payment, generateDeviceKeys().privateKey), pem), false);
  assert.equal(verifyPayment(payment, "not-base64-signature", pem), false);
});
