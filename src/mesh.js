// Offline mesh SIMULATION. Devices, radio range and connectivity are modelled in memory;
// nothing here uses real Bluetooth, Wi-Fi Direct or NFC.
//
// - Each device stores packets it has received (store-and-forward) and forwards them to
//   online neighbours within radio range during a gossip round.
// - TTL is decremented per hop; packets at TTL 0 are kept but not forwarded.
// - Devices de-duplicate by SHA-256(ciphertext), not by the outer packetId, which an
//   untrusted relay could rewrite.
// - Partitions: devices in different partitions cannot exchange packets.
// - Bridge nodes have internet; "flush" uploads everything they hold to the backend,
//   concurrently, which is exactly when duplicate deliveries happen.

import crypto from "node:crypto";
import { encryptForServer, generateDeviceKeys, sha256Hex, signPayment } from "./crypto.js";

const DEFAULT_DEVICES = [
  { id: "alice-phone", owner: "alice@demo", x: 80, y: 190 },
  { id: "bob-phone", owner: "bob@demo", x: 230, y: 70 },
  { id: "relay-1", owner: null, x: 260, y: 250 },
  { id: "relay-2", owner: null, x: 420, y: 140 },
  { id: "carol-phone", owner: "carol@demo", x: 440, y: 300 },
  { id: "bridge-1", owner: null, x: 610, y: 120, bridge: true },
  { id: "bridge-2", owner: null, x: 620, y: 290, bridge: true },
];
const DEFAULT_LINKS = [
  ["alice-phone", "bob-phone"], ["alice-phone", "relay-1"], ["bob-phone", "relay-2"], ["relay-1", "relay-2"],
  ["relay-1", "carol-phone"], ["relay-2", "bridge-1"], ["carol-phone", "bridge-2"], ["relay-2", "carol-phone"],
];
export const ACCOUNTS = [
  { vpa: "alice@demo", name: "Alice", balancePaise: 500_000 },
  { vpa: "bob@demo", name: "Bob", balancePaise: 200_000 },
  { vpa: "carol@demo", name: "Carol", balancePaise: 100_000 },
  { vpa: "dave@demo", name: "Dave", balancePaise: 0 },
];
const MAX_PACKETS = 200;
const MAX_EVENTS = 300;

export class Mesh {
  constructor(serverPublicKey) {
    this.serverPublicKey = serverPublicKey;
    this.deviceKeys = new Map(ACCOUNTS.map((a) => [a.vpa, generateDeviceKeys()])); // stays in memory
    this.reset();
  }

  reset() {
    this.devices = new Map(DEFAULT_DEVICES.map((d) => [d.id, { ...d, bridge: !!d.bridge, online: true, partition: "A", held: new Map() }]));
    this.links = DEFAULT_LINKS.map(([a, b]) => [a, b]);
    this.events = [];
    this.round = 0;
    this.packetsCreated = 0;
    this.log("reset", "Mesh reset: 7 devices, 2 internet bridges.");
  }

  publicKeys() {
    return Object.fromEntries([...this.deviceKeys].map(([vpa, k]) => [vpa, k.publicKey.export({ type: "spki", format: "pem" })]));
  }

  log(type, message, data = {}) {
    this.events.push({ seq: (this.events.at(-1)?.seq ?? 0) + 1, at: Date.now(), round: this.round, type, message, ...data });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  device(id) {
    const d = this.devices.get(id);
    if (!d) throw Object.assign(new Error(`Unknown device ${id}`), { status: 404 });
    return d;
  }

  neighbours(id) {
    return this.links.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));
  }

  setOnline(id, online) {
    this.device(id).online = online;
    this.log(online ? "online" : "offline", `${id} is now ${online ? "online" : "offline"}.`, { device: id });
  }

  setPartition(id, partition) {
    if (!/^[A-C]$/.test(partition)) throw Object.assign(new Error("Partition must be A, B or C."), { status: 400 });
    this.device(id).partition = partition;
    this.log("partition", `${id} moved to partition ${partition}.`, { device: id });
  }

  /** The sender's phone builds, signs and encrypts a payment, then holds it. */
  createPayment({ sender, receiver, amountPaise, signedAt = Date.now(), signWith = sender }) {
    const dev = [...this.devices.values()].find((d) => d.owner === sender);
    if (!dev) throw Object.assign(new Error(`No phone for ${sender} in the mesh.`), { status: 400 });
    if (this.packetsCreated >= MAX_PACKETS) throw Object.assign(new Error("Demo packet limit reached; reset the mesh."), { status: 409 });
    const keys = this.deviceKeys.get(signWith);
    if (!keys) throw Object.assign(new Error(`Unknown signer ${signWith}`), { status: 400 });
    const payment = { sender, receiver, amountPaise, nonce: crypto.randomUUID(), signedAt };
    const ciphertext = encryptForServer({ payment, signature: signPayment(payment, keys.privateKey) }, this.serverPublicKey);
    const packet = { packetId: crypto.randomUUID(), ttl: 5, createdAt: Date.now(), ciphertext };
    const hash = sha256Hex(ciphertext);
    dev.held.set(hash, { ...packet, hops: 0, hash });
    this.packetsCreated++;
    this.log("created", `${dev.id} created a signed, encrypted payment (₹${(amountPaise / 100).toFixed(2)} → ${receiver}).`, { device: dev.id, hash, packetId: packet.packetId });
    return { device: dev.id, hash, packetId: packet.packetId };
  }

  /** One synchronous gossip round over a snapshot, so a packet moves at most one hop per round. */
  gossip() {
    this.round++;
    const snapshot = new Map([...this.devices].map(([id, d]) => [id, [...d.held.values()]]));
    const transfers = [];
    for (const [srcId, packets] of snapshot) {
      const src = this.devices.get(srcId);
      if (!src.online) continue;
      for (const nId of this.neighbours(srcId)) {
        const dst = this.devices.get(nId);
        if (!dst.online || dst.partition !== src.partition) continue;
        for (const p of packets) {
          if (p.ttl <= 0 || dst.held.has(p.hash)) continue;
          dst.held.set(p.hash, { ...p, ttl: p.ttl - 1, hops: p.hops + 1 });
          transfers.push({ from: srcId, to: nId, hash: p.hash });
        }
      }
    }
    this.log("gossip", `Gossip round ${this.round}: ${transfers.length} transfer${transfers.length === 1 ? "" : "s"}.`, { transfers });
    return transfers;
  }

  /** Packets that online bridges would upload right now. */
  bridgeUploads() {
    const out = [];
    for (const d of this.devices.values()) {
      if (!d.bridge || !d.online) continue;
      for (const p of d.held.values()) out.push({ bridge: d.id, packet: p });
    }
    return out;
  }

  removeHeld(hash) {
    for (const d of this.devices.values()) d.held.delete(hash);
  }

  /** Flip one byte of a held packet's ciphertext, simulating a malicious relay. */
  tamper(deviceId, hash) {
    const d = this.device(deviceId);
    const p = d.held.get(hash);
    if (!p) throw Object.assign(new Error("That device does not hold the packet."), { status: 404 });
    const buf = Buffer.from(p.ciphertext, "base64");
    buf[buf.length - 5] ^= 0x01;
    const ciphertext = buf.toString("base64");
    const newHash = sha256Hex(ciphertext);
    d.held.delete(hash);
    d.held.set(newHash, { ...p, ciphertext, hash: newHash, tampered: true });
    this.log("tamper", `${deviceId} flipped one bit of a packet it was relaying.`, { device: deviceId, hash: newHash });
    return newHash;
  }

  state() {
    return {
      round: this.round,
      devices: [...this.devices.values()].map((d) => ({
        id: d.id, owner: d.owner, bridge: d.bridge, online: d.online, partition: d.partition, x: d.x, y: d.y,
        packets: [...d.held.values()].map((p) => ({ hash: p.hash, packetId: p.packetId, ttl: p.ttl, hops: p.hops, tampered: !!p.tampered })),
      })),
      links: this.links,
      events: this.events.slice(-80),
    };
  }
}
