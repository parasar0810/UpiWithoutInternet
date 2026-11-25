# Java → Node.js migration (November 2026)

The first version was a Spring Boot 3 / Java 17 backend with an in-memory H2 database and a Thymeleaf dashboard. It is kept unchanged in `legacy/java/` (`git log --follow legacy/java/pom.xml` shows its history). In November 2026 it was reimplemented in JavaScript (Node.js, Express, PostgreSQL) with AI pair-programming assistance.

## Carried over
| Concept | Java | Node.js |
|---|---|---|
| Hybrid encryption | RSA-OAEP + AES-256-GCM (`HybridCryptoService`) | same primitives via `node:crypto` (`src/crypto.js`) |
| Idempotency key | SHA-256 of the ciphertext | same |
| Freshness window | 24 h, 5 min clock-skew tolerance | same |
| Gossip | synchronous rounds over a snapshot, TTL 5 | same, plus per-link radio range, online/offline and partitions |
| Defence in depth | unique index on `packet_hash` | unique `packet_hash` and unique `nonce` |

## Changed, and why
| # | Original | Problem | Now | Test |
|---|---|---|---|---|
| 1 | Payload encrypted to the server, with a "pinHash" field but no signature | Anyone with the server's public key could create a valid-looking payment from any account. Encryption gives confidentiality, not sender authentication | Each account has an Ed25519 key. The sender signs a canonical encoding of every payment field, and the server verifies against the registered public key | `crypto.test.js` signature tests; `payment signed by another device is rejected` |
| 2 | Idempotency claim in a `ConcurrentHashMap` **before** a separate `@Transactional` settlement | If settlement failed (DB error, crash), the hash stayed claimed and the payment could never settle | Claim and settlement in one PostgreSQL transaction; rollback releases the claim | `a failed settlement releases the idempotency claim…` |
| 3 | `@Version` optimistic locking on accounts | Under contention, optimistic retries are needed; not exercised by the original tests | Row locks taken one statement at a time in sorted order. A first attempt with one `SELECT … ORDER BY … FOR UPDATE` **deadlocked** in testing, because PostgreSQL does not guarantee lock order there | `total money is conserved under concurrent, opposite transfers`; `concurrent overdraft attempts…` |
| 4 | Re-delivery of a re-encrypted (new ciphertext) copy of a signed payment would get a new hash | Not covered | `nonce UUID UNIQUE` rejects it as `replayed_nonce` | `re-encrypted replay…` |
| 5 | Devices de-duplicated by the outer `packetId` | An untrusted relay could rewrite it | De-duplicate by ciphertext hash | `devices de-duplicate by ciphertext hash…` |
| 6 | H2 console exposed, no rate limits | Unsafe if deployed | PostgreSQL, no admin console, per-client rate limit, body and packet caps | `rate limit applies…` |

## Résumé alignment
The October 2026 résumé described this project as "Node.js and Express.js with PostgreSQL". That is accurate from this migration onwards. The honest description is "built in Java/Spring Boot, then reimplemented in Node.js with PostgreSQL".
