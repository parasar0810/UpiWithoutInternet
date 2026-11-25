import { readFile } from "node:fs/promises";
import pg from "pg";

// BIGINT columns come back as strings by default; balances fit safely in JS numbers here
// (paise totals in the demo are far below 2^53), so parse them for convenience.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  return new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 10), idleTimeoutMillis: 10_000 });
}

export async function migrate(pool) {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}

/** Reset the demo ledger: fixed fictional balances and the simulator's device public keys. */
export async function seed(pool, accounts, publicKeys) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE transactions, processed_packets, accounts");
    for (const a of accounts) {
      await client.query("INSERT INTO accounts (vpa, name, balance_paise, public_key) VALUES ($1, $2, $3, $4)", [a.vpa, a.name, a.balancePaise, publicKeys[a.vpa]]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function ledger(pool) {
  const [accounts, txs, packets, totals] = await Promise.all([
    pool.query("SELECT vpa, name, balance_paise FROM accounts ORDER BY vpa"),
    pool.query("SELECT id, packet_hash, sender, receiver, amount_paise, status, reason, signed_at, settled_at, bridge_node, hop_count FROM transactions ORDER BY id DESC LIMIT 50"),
    pool.query("SELECT packet_hash, outcome, reason, bridge_node, received_at FROM processed_packets ORDER BY received_at DESC LIMIT 50"),
    pool.query("SELECT COALESCE(SUM(balance_paise), 0) AS total FROM accounts"),
  ]);
  return { accounts: accounts.rows, transactions: txs.rows, processed: packets.rows, totalPaise: Number(totals.rows[0].total) };
}
