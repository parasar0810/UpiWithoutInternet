// Bridge ingestion: the only path by which a packet can move (simulated) money.
//
//   1. hash = SHA-256(ciphertext)
//   2. BEGIN; INSERT INTO processed_packets ... ON CONFLICT DO NOTHING   ← atomic claim
//        no row inserted  → DUPLICATE_DROPPED (another delivery won)
//   3. decrypt (RSA-OAEP + AES-GCM)            → INVALID on failure
//   4. verify the sender's Ed25519 signature    → INVALID on failure
//   5. freshness window + clock-skew check      → INVALID (stale / future)
//   6. lock both accounts FOR UPDATE, one statement each in sorted order (no deadlocks),
//      check balance, debit + credit, insert the transaction row
//   7. COMMIT. Any exception → ROLLBACK, which also releases the claim so the packet
//      can be retried. (The Java original claimed in memory before settling, so a failed
//      settlement left the packet permanently "seen" and never settled.)
//
// Guarantee, precisely scoped: within this PostgreSQL database, at most one committed
// settlement exists per packet hash (PRIMARY KEY + UNIQUE constraints), however many
// times or however concurrently the packet is delivered. It says nothing about delivery
// in the mesh itself, which is at-least-once by design.

import { DecryptionError, decryptAtServer, sha256Hex, verifyPayment } from "./crypto.js";

export const OUTCOME = { SETTLED: "SETTLED", REJECTED: "REJECTED", DUPLICATE: "DUPLICATE_DROPPED", INVALID: "INVALID" };

const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

function validPayment(p) {
  return p && typeof p.sender === "string" && typeof p.receiver === "string" && p.sender !== p.receiver &&
    Number.isSafeInteger(p.amountPaise) && p.amountPaise > 0 && p.amountPaise <= 10_000_000 &&
    isUuid(p.nonce) && Number.isSafeInteger(p.signedAt);
}

export async function ingest(pool, serverPrivateKey, packet, { bridgeNode = null, hopCount = null, maxAgeMs = 86_400_000, now = Date.now() } = {}) {
  if (!packet || typeof packet.ciphertext !== "string" || packet.ciphertext.length > 8192) {
    return { outcome: OUTCOME.INVALID, reason: "malformed_packet", packetHash: null };
  }
  const packetHash = sha256Hex(packet.ciphertext);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      "INSERT INTO processed_packets (packet_hash, outcome, bridge_node, hop_count) VALUES ($1, 'PENDING', $2, $3) ON CONFLICT DO NOTHING RETURNING packet_hash",
      [packetHash, bridgeNode, hopCount],
    );
    if (claim.rowCount === 0) {
      await client.query("ROLLBACK");
      return { outcome: OUTCOME.DUPLICATE, packetHash };
    }

    const finish = async (outcome, reason, extra = {}) => {
      await client.query("UPDATE processed_packets SET outcome = $2, reason = $3 WHERE packet_hash = $1", [packetHash, outcome, reason]);
      await client.query("COMMIT");
      return { outcome, reason, packetHash, ...extra };
    };

    let envelope;
    try {
      envelope = decryptAtServer(packet.ciphertext, serverPrivateKey);
    } catch (e) {
      if (e instanceof DecryptionError) return finish(OUTCOME.INVALID, "decryption_failed");
      throw e;
    }
    const { payment, signature } = envelope ?? {};
    if (!validPayment(payment) || typeof signature !== "string") return finish(OUTCOME.INVALID, "invalid_payload");

    const sender = await client.query("SELECT public_key FROM accounts WHERE vpa = $1", [payment.sender]);
    if (!sender.rowCount) return finish(OUTCOME.INVALID, "unknown_sender");
    if (!verifyPayment(payment, signature, sender.rows[0].public_key)) return finish(OUTCOME.INVALID, "bad_signature");

    const age = now - payment.signedAt;
    if (age > maxAgeMs) return finish(OUTCOME.INVALID, "stale_packet");
    if (age < -300_000) return finish(OUTCOME.INVALID, "future_dated");

    // Lock the two account rows one at a time in a fixed (sorted) order so that opposite
    // transfers (A→B and B→A) can never deadlock. A single "SELECT ... ORDER BY ... FOR UPDATE"
    // does not guarantee lock order in PostgreSQL, and deadlocked under concurrent tests.
    const rows = {};
    for (const vpa of [payment.sender, payment.receiver].sort()) {
      const r = await client.query("SELECT balance_paise FROM accounts WHERE vpa = $1 FOR UPDATE", [vpa]);
      if (!r.rowCount) return finish(OUTCOME.INVALID, vpa === payment.sender ? "unknown_sender" : "unknown_receiver");
      rows[vpa] = r.rows[0];
    }
    const balance = BigInt(rows[payment.sender].balance_paise);

    const record = async (status, reason) =>
      (await client.query(
        `INSERT INTO transactions (packet_hash, nonce, sender, receiver, amount_paise, status, reason, signed_at, bridge_node, hop_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8 / 1000.0),$9,$10) RETURNING id`,
        [packetHash, payment.nonce, payment.sender, payment.receiver, payment.amountPaise, status, reason, payment.signedAt, bridgeNode, hopCount],
      )).rows[0].id;

    if (balance < BigInt(payment.amountPaise)) {
      const id = await record("REJECTED", "insufficient_balance");
      return finish(OUTCOME.REJECTED, "insufficient_balance", { transactionId: Number(id), payment });
    }
    await client.query("UPDATE accounts SET balance_paise = balance_paise - $2 WHERE vpa = $1", [payment.sender, payment.amountPaise]);
    await client.query("UPDATE accounts SET balance_paise = balance_paise + $2 WHERE vpa = $1", [payment.receiver, payment.amountPaise]);
    const id = await record("SETTLED", null);
    return finish(OUTCOME.SETTLED, null, { transactionId: Number(id), payment });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") return { outcome: OUTCOME.INVALID, reason: "replayed_nonce", packetHash }; // unique nonce
    throw err;
  } finally {
    client.release();
  }
}
