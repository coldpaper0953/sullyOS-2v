import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

const key = createHash('sha256').update(config.modelVaultKey).digest();

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  const [version, ivText, tagText, encryptedText] = value.split(':');
  if (version !== 'v1' || !ivText || !tagText || encryptedText === undefined) {
    throw new Error('Unsupported encrypted model credential format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
