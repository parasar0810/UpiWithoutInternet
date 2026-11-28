import { readFile } from "node:fs/promises";
import pg from "pg";

// BIGINT columns come back as strings by default; balances fit safely in JS numbers here
// (paise totals in the demo are far below 2^53), so parse them for convenience.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  if (!/^postgres(ql)?:\/\/[^/\s]+@[^/\s]+/.test(connectionString.trim())) {
    // Never print the value: it contains the password.
    throw new Error(
      "DATABASE_URL is not a PostgreSQL URL (expected postgresql://user:password@host/db?sslmode=require). " +
      "Paste only the value — no 'DATABASE_URL=' prefix, quotes or masked '****' text.",
    );
  }
  return new pg.Pool({ connectionString: connectionString.trim(), max: Number(process.env.PG_POOL_MAX ?? 10), idleTimeoutMillis: 10_000 });
}

export async function migrate(pool) {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}

export const DEFAULT_SANDBOX = "default";

/** Reset one sandbox's ledger: fixed fictional balances and that sandbox's device public keys. */
export async function seed(pool, accounts, publicKeys, sandbox = DEFAULT_SANDBOX) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await deleteRows(client, sandbox);
    for (const a of accounts) {
      await client.query("INSERT INTO accounts (sandbox, vpa, name, balance_paise, public_key) VALUES ($1, $2, $3, $4, $5)",
        [sandbox, a.vpa, a.name, a.balancePaise, publicKeys[a.vpa]]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function deleteRows(db, sandbox) {
  await db.query("DELETE FROM transactions WHERE sandbox = $1", [sandbox]);
  await db.query("DELETE FROM processed_packets WHERE sandbox = $1", [sandbox]);
  await db.query("DELETE FROM accounts WHERE sandbox = $1", [sandbox]);
}

/** Delete every row of one sandbox (used when an idle sandbox expires). */
export async function dropSandbox(pool, sandbox) {
  await deleteRows(pool, sandbox);
}

/** Remove all sandboxes. Called on start: in-memory meshes don't survive a restart. */
export async function clearAll(pool) {
  await pool.query("TRUNCATE transactions, processed_packets, accounts");
}

export async function ledger(pool, sandbox = DEFAULT_SANDBOX) {
  const [accounts, txs, packets, totals] = await Promise.all([
    pool.query("SELECT vpa, name, balance_paise FROM accounts WHERE sandbox = $1 ORDER BY vpa", [sandbox]),
    pool.query("SELECT id, packet_hash, sender, receiver, amount_paise, status, reason, signed_at, settled_at, bridge_node, hop_count FROM transactions WHERE sandbox = $1 ORDER BY id DESC LIMIT 50", [sandbox]),
    pool.query("SELECT packet_hash, outcome, reason, bridge_node, received_at FROM processed_packets WHERE sandbox = $1 ORDER BY received_at DESC LIMIT 50", [sandbox]),
    pool.query("SELECT COALESCE(SUM(balance_paise), 0) AS total FROM accounts WHERE sandbox = $1", [sandbox]),
  ]);
  return { accounts: accounts.rows, transactions: txs.rows, processed: packets.rows, totalPaise: Number(totals.rows[0].total) };
}
