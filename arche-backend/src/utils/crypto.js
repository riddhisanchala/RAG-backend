// AES-256-GCM encryption for secrets (provider API keys) stored in MongoDB.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv.tag.ciphertext (base64)
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(payload) {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', env.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
