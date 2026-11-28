-- UPI Offline Mesh — settlement schema (PostgreSQL).
-- Simulation only: balances are fictional and no real money moves.
--
-- Every row belongs to a sandbox: one per visitor of the public demo, so visitors never see
-- or change each other's ledgers. All keys and uniqueness rules are scoped by sandbox.

-- Upgrade from the single-ledger schema (demo data only, recreated on start): drop the old
-- tables if they lack the sandbox column.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'accounts')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'accounts' AND column_name = 'sandbox') THEN
    DROP TABLE IF EXISTS transactions, processed_packets, accounts;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS accounts (
  sandbox       TEXT NOT NULL,
  vpa           TEXT NOT NULL,                         -- simulated UPI id, e.g. alice@demo
  name          TEXT NOT NULL,
  balance_paise BIGINT NOT NULL CHECK (balance_paise >= 0),
  public_key    TEXT NOT NULL,                         -- sender's Ed25519 public key (PEM, SPKI)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox, vpa)
);

-- One row per packet hash seen at the backend (per sandbox). The PRIMARY KEY is the
-- idempotency gate: INSERT ... ON CONFLICT DO NOTHING is atomic, so concurrent deliveries
-- of the same packet cannot both proceed. The row is written in the same transaction as
-- settlement, so a failed settlement rolls the claim back and the packet can be retried.
CREATE TABLE IF NOT EXISTS processed_packets (
  sandbox      TEXT NOT NULL,
  packet_hash  CHAR(64) NOT NULL,                      -- SHA-256 of the ciphertext, hex
  outcome      TEXT NOT NULL,                          -- SETTLED | REJECTED | INVALID
  reason       TEXT,
  bridge_node  TEXT,
  hop_count    INT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox, packet_hash)
);

CREATE TABLE IF NOT EXISTS transactions (
  id           BIGSERIAL PRIMARY KEY,
  sandbox      TEXT NOT NULL,
  packet_hash  CHAR(64) NOT NULL,
  nonce        UUID NOT NULL,                          -- defence in depth against replays
  sender       TEXT NOT NULL,
  receiver     TEXT NOT NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  status       TEXT NOT NULL CHECK (status IN ('SETTLED', 'REJECTED')),
  reason       TEXT,
  signed_at    TIMESTAMPTZ NOT NULL,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  bridge_node  TEXT,
  hop_count    INT,
  CHECK (sender <> receiver),
  UNIQUE (sandbox, packet_hash),
  UNIQUE (sandbox, nonce),
  FOREIGN KEY (sandbox, packet_hash) REFERENCES processed_packets (sandbox, packet_hash) ON DELETE CASCADE,
  FOREIGN KEY (sandbox, sender) REFERENCES accounts (sandbox, vpa) ON DELETE CASCADE,
  FOREIGN KEY (sandbox, receiver) REFERENCES accounts (sandbox, vpa) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS transactions_sandbox_settled_at ON transactions (sandbox, settled_at DESC);
CREATE INDEX IF NOT EXISTS processed_packets_sandbox_received_at ON processed_packets (sandbox, received_at DESC);
