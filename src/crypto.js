// Cryptography with Node's built-in `node:crypto` only — no custom primitives.
//
//   Confidentiality + integrity:  hybrid encryption. A fresh AES-256-GCM key per packet
//                                  encrypts the payload; RSA-OAEP (SHA-256) wraps that key
//                                  for the server. GCM's tag detects any modification.
//   Sender authentication:        the sender's device signs the payment with Ed25519; the
//                                  server verifies against the account's registered key.
//                                  (Encryption alone does not authenticate the sender:
//                                  anyone with the server's public key can encrypt.)
//   Idempotency key:               SHA-256 of the ciphertext.
//
// Wire format of `ciphertext` (base64):  [2-byte key length][RSA-wrapped key][12-byte IV][GCM tag 16][AES ciphertext]

import crypto from "node:crypto";

export function generateServerKeys() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
}

export function generateDeviceKeys() {
  return crypto.generateKeyPairSync("ed25519");
}

export const exportPublicPem = (key) => key.export({ type: "spki", format: "pem" });

/** Canonical bytes that the sender signs: fixed field order, no whitespace ambiguity. */
export function canonicalPayment(p) {
  return Buffer.from(JSON.stringify([p.sender, p.receiver, p.amountPaise, p.nonce, p.signedAt]), "utf8");
}

export function signPayment(payment, devicePrivateKey) {
  return crypto.sign(null, canonicalPayment(payment), devicePrivateKey).toString("base64");
}

export function verifyPayment(payment, signatureB64, publicKeyPem) {
  try {
    return crypto.verify(null, canonicalPayment(payment), crypto.createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Sender side: encrypt {payment, signature} for the server. */
export function encryptForServer(obj, serverPublicKey) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = crypto.publicEncrypt({ key: serverPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(wrapped.length);
  return Buffer.concat([len, wrapped, iv, tag, body]).toString("base64");
}

export class DecryptionError extends Error {}

/** Server side: unwrap the AES key and decrypt; throws DecryptionError on any tampering. */
export function decryptAtServer(ciphertextB64, serverPrivateKey) {
  try {
    const buf = Buffer.from(ciphertextB64, "base64");
    const klen = buf.readUInt16BE(0);
    const wrapped = buf.subarray(2, 2 + klen);
    const iv = buf.subarray(2 + klen, 14 + klen);
    const tag = buf.subarray(14 + klen, 30 + klen);
    const body = buf.subarray(30 + klen);
    const aesKey = crypto.privateDecrypt({ key: serverPrivateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch (err) {
    throw new DecryptionError(`decryption failed: ${err.code ?? err.message}`);
  }
}

export const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
