# UPI Offline Mesh — offline payment network simulation

A **simulation** of how a payment could travel from a phone with no connectivity, hop through untrusted nearby phones, and settle **exactly once** when any phone carrying it reaches the internet. Built with **Node.js, Express and PostgreSQL**.

> **Simulation only.** Accounts, balances and devices are fictional. No real money, UPI IDs, bank data or radio hardware are involved. The mesh is simulated in memory; it does not use real Bluetooth, Wi-Fi Direct or NFC.

![Simulation console](docs/screenshots/console.png)

| | |
|---|---|
| **Stack** | Node.js 22 · Express 5 · PostgreSQL 16 (`pg`) · `node:crypto` · React + TypeScript + Tailwind |
| **Tests** | 38 `node:test` cases against a real PostgreSQL, stable across repeated runs |
| **Live demo** | https://upi-offline-mesh-0r6x.onrender.com (Render free tier + Neon PostgreSQL; the first request after idle can take up to a minute) |

## What it demonstrates
1. **Untrusted relays can carry a payment without reading or altering it.** Hybrid encryption: a fresh AES-256-GCM key per packet, wrapped with the server's RSA-OAEP (SHA-256) key. Any flipped bit fails the GCM tag.
2. **Only the real sender can create a payment.** Each account signs payments with **Ed25519**, and the server verifies the signature against the registered public key. Encryption alone would not prove who sent the packet.
3. **Concurrent duplicate deliveries settle once.** The SHA-256 of the ciphertext is claimed with `INSERT … ON CONFLICT DO NOTHING` in the *same transaction* as the settlement.
4. **Replays are rejected:**
   - an identical packet → duplicate;
   - a re-encrypted copy of a signed payment → unique `nonce` violation;
   - an old packet → 24-hour freshness window.

## Architecture

```mermaid
flowchart LR
  S[Sender phone<br/>sign Ed25519 → encrypt AES-GCM + RSA-OAEP] -- gossip, TTL 5 --> R1[Relay phones<br/>store-and-forward<br/>dedupe by SHA-256]
  R1 -- gossip --> B[Bridge phones<br/>have internet]
  B -- concurrent uploads --> API[Express /api/mesh/flush]
  API --> T{{PostgreSQL transaction}}
  T --> C[claim packet hash<br/>ON CONFLICT DO NOTHING]
  C --> D[decrypt · verify signature · freshness]
  D --> L[lock accounts in sorted order<br/>debit · credit · record]
  L --> K[(COMMIT — or ROLLBACK releases the claim)]
```

**Guarantee, precisely.** Within this PostgreSQL database there is **at most one committed settlement per packet hash**, enforced by the `processed_packets` primary key and unique constraints on `transactions.packet_hash` and `nonce`. Delivery through the mesh is deliberately *at-least-once*. "Exactly once" here means one settlement for however many deliveries, not exactly-once networking.

## The console
- **Mesh network:** seven devices, radio-range links and two internet bridges.
  - Click a device to disconnect it or move it to another partition.
  - Each gossip round highlights the transfers that actually happened.
- **New offline payment:** sender, receiver and a simulated amount.
- **Security & failure lab:** six scenarios run through the same ingestion path bridges use. Results observed:

| Scenario | Backend result |
|---|---|
| 5 bridges deliver one packet at once | 1 `SETTLED`, 4 `DUPLICATE_DROPPED` |
| Re-submit a settled packet | `SETTLED`, then `DUPLICATE_DROPPED` |
| Relay flips one ciphertext bit | `INVALID` · `decryption_failed` |
| Payment signed by the wrong device | `INVALID` · `bad_signature` |
| Payment signed 25 h ago | `INVALID` · `stale_packet` |
| Spend more than the balance | `REJECTED` · `insufficient_balance` (recorded, no money moves) |

- **Settlement ledger and backend packet log:** read live from PostgreSQL. The total money in the system is shown and stays constant.

## Run it

```bash
docker compose up --build          # API + PostgreSQL → http://localhost:8080 (UPI_PORT=… to change)
```

Or without Docker (needs a PostgreSQL 14+ you can reach):

```bash
npm ci && (cd frontend && npm ci && npm run build)
DATABASE_URL=postgres://user:pass@localhost:5432/upi npm start
```

The schema is created at start-up, and the demo ledger is reset to fixed fictional balances.

## Deploy (free tier)
1. Create a free PostgreSQL database on [Neon](https://neon.com) and copy its pooled connection string (it ends in `?sslmode=require`).
2. In [Render](https://render.com): **New → Blueprint**, then pick this repository. `render.yaml` defines one free Docker web service.
3. Paste the connection string as `DATABASE_URL` when Render asks for it.

The schema is created on start and the demo ledger is reset on start, so a free instance spinning down only resets the simulation. Writes are rate-limited (`UPI_RATE_LIMIT_PER_MIN`, 60 in the blueprint).

## Tests

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/upi_test npm test
```

| File | Covers |
|---|---|
| `crypto.test.js` | Round-trip; fresh key/IV per packet; any bit flip rejected; wrong server key rejected; signature covers every field and fails with the wrong key |
| `mesh.test.js` | One hop per round; TTL decrement and limit; offline devices hold packets and resume; partitions block delivery; dedupe by ciphertext hash |
| `settlement.test.js` | Valid settlement; **20 concurrent deliveries → 1 settlement**; **money conserved under concurrent opposite transfers**; **10 concurrent overdraft attempts → only the affordable 3 settle**; tamper, replay, re-encrypted replay, stale and future packets, forged sender; insufficient balance recorded; **failed settlement releases the claim and can be retried** |
| `api.test.js` | Full HTTP flow; bridge offline until reconnect; all six scenarios; validation; no private keys in responses; rate limiting |

The settlement and API tests need a real PostgreSQL (CI starts one as a service) and are skipped without `DATABASE_URL`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Devices, packets, events, accounts, ledger |
| POST | `/api/payments` | `{sender, receiver, amountRupees}` — sender's phone creates a packet |
| POST | `/api/mesh/gossip` | One gossip round |
| POST | `/api/mesh/flush` | Online bridges upload concurrently |
| POST | `/api/mesh/devices/{id}` | `{online?, partition?}` |
| POST | `/api/scenarios/{name}` | Run a failure scenario |
| POST | `/api/reset` | Reset mesh and ledger |
| GET | `/api/server-key` | Server RSA public key |

**Per-visitor sandboxes.** Each visitor gets a private sandbox, identified by a random ID in an HttpOnly cookie. It contains its own simulated phones, device keys, accounts, ledger and idempotency records; every table is keyed by `sandbox`. Sandboxes idle for `UPI_SANDBOX_TTL_MIN` (30) minutes are deleted. At most `UPI_MAX_SANDBOXES` (100) exist at once, and the least recently used is evicted first.

State-changing requests are rate-limited per client (120 per minute by default). Bodies are capped at 32 KB, and the number of demo packets is capped.

## History
The project was first a Java 17 / Spring Boot backend with H2, kept unchanged in [`legacy/java`](legacy/java). In November 2026 it was reimplemented in JavaScript with AI pair-programming assistance. See [docs/MIGRATION.md](docs/MIGRATION.md) for what changed and why, including two defects in the original that the migration fixed.

## Limitations
- **Deferred settlement, not real-time offline payment.** The receiver can't verify funds offline, and a sender can double-spend across disconnected groups until one packet reaches the backend. Real offline UPI (UPI Lite) uses a pre-funded, hardware-backed wallet to solve this.
- Device keys live in the simulator's memory; real phones would keep them in secure hardware.
- The server's RSA key is regenerated at start-up; production would use a KMS or HSM.
- Bridges are trusted to upload. Production would authenticate them (mutual TLS) and rate-limit per bridge.
- Sandboxes live in one server process: a restart (or a free instance spinning down) clears them all, and they don't scale across replicas. That's fine for a demo; a multi-instance deployment would keep mesh state in shared storage.
