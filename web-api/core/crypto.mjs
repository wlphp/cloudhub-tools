import fs from "node:fs";
import crypto from "node:crypto";
import { keyPath } from "./paths.mjs";

export function decryptSecret(ciphertext) {
  const packed = Buffer.from(ciphertext, "base64");
  const key = fs.readFileSync(keyPath);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(packed.length - 16));
  return Buffer.concat([decipher.update(packed.subarray(12, packed.length - 16)), decipher.final()]).toString("utf8");
}

export function encryptSecret(secret) {
  const key = fs.readFileSync(keyPath);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64");
}
