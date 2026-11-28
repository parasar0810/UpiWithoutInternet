// Express API for the UPI Offline Mesh simulation.
import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exportPublicPem, generateServerKeys, sha256Hex } from "./crypto.js";
import { clearAll, dropSandbox, ledger, migrate, seed } from "./db.js";
import { ACCOUNTS, Mesh } from "./mesh.js";
import { OUTCOME, ingest } from "./settlement.js";

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export const SANDBOX_COOKIE = "upi_sandbox";
const isSandboxId = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const readCookie = (header, name) => {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
};

export async function createApp(pool, {
  serverKeys = generateServerKeys(),
  rateLimitPerMin = Number(process.env.UPI_RATE_LIMIT_PER_MIN ?? 120),
  trustProxy = process.env.UPI_TRUST_PROXY === "1",
  maxSandboxes = Number(process.env.UPI_MAX_SANDBOXES ?? 100),
  sandboxTtlMs = Number(process.env.UPI_SANDBOX_TTL_MIN ?? 30) * 60_000,
  secureCookie = process.env.NODE_ENV === "production",
} = {}) {
  await migrate(pool);
  await clearAll(pool); // meshes live in memory, so sandboxes from a previous process are orphaned

  // One isolated sandbox per visitor: its own simulated phones (and device keys) in memory and
  // its own accounts, ledger and idempotency rows in PostgreSQL, all keyed by a random id held
  // in an HttpOnly cookie. Map order is least-recently-used first.
  const sandboxes = new Map(); // id -> Promise<{ id, mesh, lastSeen }>
  const drop = (id) => { sandboxes.delete(id); return dropSandbox(pool, id).catch((e) => console.error("sandbox cleanup failed", e)); };
  async function getSandbox(req, res) {
    let id = readCookie(req.headers.cookie, SANDBOX_COOKIE);
    if (!isSandboxId(id)) id = randomUUID();
    let entry = sandboxes.get(id);
    if (entry) {
      sandboxes.delete(id); // move to the most-recently-used end
    } else {
      while (sandboxes.size >= maxSandboxes) await drop(sandboxes.keys().next().value);
      entry = (async () => {
        const mesh = new Mesh(serverKeys.publicKey);
        await seed(pool, ACCOUNTS, mesh.publicKeys(), id);
        return { id, mesh, lastSeen: Date.now() };
      })();
      entry.catch(() => sandboxes.delete(id));
    }
    sandboxes.set(id, entry);
    const sb = await entry;
    sb.lastSeen = Date.now();
    res.cookie(SANDBOX_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: secureCookie, maxAge: sandboxTtlMs, path: "/" });
    return sb;
  }
  const sweeper = setInterval(async () => {
    const cutoff = Date.now() - sandboxTtlMs;
    for (const [id, entry] of [...sandboxes]) {
      const sb = await entry.catch(() => null);
      if (sb && sb.lastSeen < cutoff) await drop(id);
    }
  }, Math.min(60_000, sandboxTtlMs)).unref();

  const app = express();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", 1);
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
    next();
  });

  // Per-client rate limit on state-changing requests.
  const hits = new Map();
  app.use((req, res, next) => {
    if (req.method === "GET") return next();
    const now = Date.now(), key = req.ip;
    const q = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (q.length >= rateLimitPerMin) return res.status(429).json({ error: { code: "rate_limited", message: `Limit is ${rateLimitPerMin} actions per minute.` } });
    q.push(now);
    hits.set(key, q);
    next();
  });

  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
  const vpas = new Set(ACCOUNTS.map((a) => a.vpa));

  async function flush({ id: sandbox, mesh }) {
    const uploads = mesh.bridgeUploads();
    // Concurrent, like several phones reaching 4G at once — this is where duplicates race.
    const results = await Promise.all(uploads.map(({ bridge, packet }) =>
      ingest(pool, serverKeys.privateKey, packet, { sandbox, bridgeNode: bridge, hopCount: packet.hops }).then((r) => ({ bridge, ...r }))));
    for (const r of results) {
      mesh.log("ingest", `${r.bridge} → backend: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`, { device: r.bridge, hash: r.packetHash, outcome: r.outcome, reason: r.reason ?? null });
      if (r.outcome !== OUTCOME.DUPLICATE && r.packetHash) mesh.removeHeld(r.packetHash); // acknowledged → stop carrying
    }
    return results;
  }

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.get("/api/server-key", (req, res) => res.json({ algorithm: "RSA-OAEP-256 (2048-bit)", publicKey: exportPublicPem(serverKeys.publicKey) }));

  // Every other API call runs inside the caller's sandbox.
  app.use("/api", asyncRoute(async (req, res, next) => { req.sb = await getSandbox(req, res); next(); }));

  app.get("/api/state", asyncRoute(async (req, res) => {
    res.json({ mesh: req.sb.mesh.state(), ledger: await ledger(pool, req.sb.id), simulation: true, sandbox: { isolated: true, idleMinutes: Math.round(sandboxTtlMs / 60_000) } });
  }));

  app.post("/api/payments", asyncRoute(async (req, res) => {
    const { sender, receiver, amountRupees } = req.body ?? {};
    if (!vpas.has(sender) || !vpas.has(receiver) || sender === receiver) throw fail(400, "invalid_input", "Choose two different demo accounts.");
    const amountPaise = Math.round(Number(amountRupees) * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 10_000_000) throw fail(400, "invalid_input", "Amount must be between ₹0.01 and ₹1,00,000.");
    res.status(201).json(req.sb.mesh.createPayment({ sender, receiver, amountPaise }));
  }));

  app.post("/api/mesh/gossip", (req, res) => res.json({ round: req.sb.mesh.round + 1, transfers: req.sb.mesh.gossip() }));
  app.post("/api/mesh/flush", asyncRoute(async (req, res) => res.json({ results: await flush(req.sb) })));

  app.post("/api/mesh/devices/:id", (req, res) => {
    const { online, partition } = req.body ?? {};
    const { mesh } = req.sb;
    if (typeof online === "boolean") mesh.setOnline(req.params.id, online);
    if (typeof partition === "string") mesh.setPartition(req.params.id, partition);
    res.json(mesh.state().devices.find((d) => d.id === req.params.id));
  });

  app.post("/api/reset", asyncRoute(async (req, res) => {
    const { id, mesh } = req.sb;
    mesh.reset();
    await seed(pool, ACCOUNTS, mesh.publicKeys(), id);
    res.json({ ok: true });
  }));

  // Controlled failure scenarios. Each returns what the backend actually did.
  app.post("/api/scenarios/:name", asyncRoute(async (req, res) => {
    const name = req.params.name;
    const { id: sandbox, mesh } = req.sb;
    const one = (p) => ({ ciphertext: p.ciphertext });
    const make = (opts) => {
      const { device, hash } = mesh.createPayment({ sender: "alice@demo", receiver: "bob@demo", amountPaise: 10_000, ...opts });
      return { device, hash, packet: mesh.device(device).held.get(hash) };
    };
    const deliver = (packet, bridge = "scenario") => ingest(pool, serverKeys.privateKey, one(packet), { sandbox, bridgeNode: bridge, hopCount: packet.hops });
    let result;
    if (name === "concurrent-duplicates") {
      const { packet, hash } = make({});
      const outcomes = await Promise.all(Array.from({ length: 5 }, (_, i) => deliver(packet, `bridge-${i + 1}`)));
      mesh.removeHeld(hash);
      result = { description: "The same packet delivered by 5 bridges simultaneously.", outcomes: outcomes.map((o) => o.outcome) };
    } else if (name === "tampered") {
      const { device, hash } = make({});
      const bad = mesh.tamper(device, hash);
      const r = await deliver(mesh.device(device).held.get(bad));
      mesh.removeHeld(bad);
      result = { description: "A relay flipped one bit of the ciphertext.", outcomes: [r.outcome], reason: r.reason };
    } else if (name === "replay") {
      const { packet, hash } = make({});
      const first = await deliver(packet);
      const again = await deliver(packet);
      mesh.removeHeld(hash);
      result = { description: "A settled packet captured and re-submitted later.", outcomes: [first.outcome, again.outcome] };
    } else if (name === "expired") {
      const { packet, hash } = make({ signedAt: Date.now() - 25 * 3_600_000 });
      const r = await deliver(packet);
      mesh.removeHeld(hash);
      result = { description: "A payment signed 25 hours ago (freshness window is 24 h).", outcomes: [r.outcome], reason: r.reason };
    } else if (name === "forged-sender") {
      const { packet, hash } = make({ signWith: "carol@demo" });
      const r = await deliver(packet);
      mesh.removeHeld(hash);
      result = { description: "Carol’s device encrypts a payment claiming to be from Alice.", outcomes: [r.outcome], reason: r.reason };
    } else if (name === "insufficient-balance") {
      const { device, hash } = mesh.createPayment({ sender: "carol@demo", receiver: "bob@demo", amountPaise: 9_000_000 });
      const r = await deliver(mesh.device(device).held.get(hash));
      mesh.removeHeld(hash);
      result = { description: "Carol tries to send ₹90,000 with ₹1,000 in the account.", outcomes: [r.outcome], reason: r.reason };
    } else {
      throw fail(404, "not_found", "Unknown scenario.");
    }
    mesh.log("scenario", `Scenario ${name}: ${result.outcomes.join(", ")}${result.reason ? ` (${result.reason})` : ""}`, { scenario: name });
    res.json({ scenario: name, ...result });
  }));

  // Built web app (same origin).
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use("/api", (req, res) => res.status(404).json({ error: { code: "not_found", message: "Unknown endpoint." } }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status ?? (err.type === "entity.parse.failed" ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: { code: err.code && typeof err.code === "string" && !/^\d/.test(err.code) ? err.code : status === 400 ? "invalid_input" : "internal_error", message: status >= 500 ? "Internal error." : err.message } });
  });

  const close = () => clearInterval(sweeper);
  return { app, serverKeys, sandboxes, close, sha256Hex };
}
