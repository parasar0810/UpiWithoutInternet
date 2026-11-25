-- UPI Offline Mesh — settlement schema (PostgreSQL).
-- Simulation only: balances are fictional and no real money moves.

CREATE TABLE IF NOT EXISTS accounts (
  vpa          TEXT PRIMARY KEY,                       -- simulated UPI id, e.g. alice@demo
  name         TEXT NOT NULL,
  balance_paise BIGINT NOT NULL CHECK (balance_paise >= 0),
  public_key   TEXT NOT NULL,                          -- sender's Ed25519 public key (PEM, SPKI)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per packet hash ever seen at the backend. The PRIMARY KEY is the idempotency
-- gate: INSERT ... ON CONFLICT DO NOTHING is atomic, so concurrent deliveries of the same
-- packet cannot both proceed. The row is written in the same transaction as settlement,
-- so a failed settlement rolls the claim back and the packet can be retried.
CREATE TABLE IF NOT EXISTS processed_packets (
  packet_hash  CHAR(64) PRIMARY KEY,                   -- SHA-256 of the ciphertext, hex
  outcome      TEXT NOT NULL,                          -- SETTLED | REJECTED | INVALID
  reason       TEXT,
  bridge_node  TEXT,
  hop_count    INT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id           BIGSERIAL PRIMARY KEY,
  packet_hash  CHAR(64) NOT NULL UNIQUE REFERENCES processed_packets(packet_hash),
  nonce        UUID NOT NULL UNIQUE,                   -- defence in depth against replays
  sender       TEXT NOT NULL REFERENCES accounts(vpa),
  receiver     TEXT NOT NULL REFERENCES accounts(vpa),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  status       TEXT NOT NULL CHECK (status IN ('SETTLED', 'REJECTED')),
  reason       TEXT,
  signed_at    TIMESTAMPTZ NOT NULL,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  bridge_node  TEXT,
  hop_count    INT,
  CHECK (sender <> receiver)
);

CREATE INDEX IF NOT EXISTS transactions_settled_at ON transactions (settled_at DESC);
