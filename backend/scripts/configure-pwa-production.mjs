#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import webPush from 'web-push';

const [, , envPathArg, publicOriginArg, emailArg] = process.argv;

if (!envPathArg || !publicOriginArg || !emailArg) {
  console.error('Usage: configure-pwa-production.mjs <env-file> <https-origin> <email>');
  process.exit(1);
}

const envPath = path.resolve(envPathArg);
const publicOrigin = new URL(publicOriginArg).origin;
if (!publicOrigin.startsWith('https://')) {
  throw new Error('The public PWA origin must use HTTPS.');
}

let source = fs.readFileSync(envPath, 'utf8');

function readValue(key) {
  const match = source.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) return '';
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function setValue(key, value) {
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^${key}=.*$`, 'm');
  if (matcher.test(source)) {
    source = source.replace(matcher, line);
  } else {
    source = `${source.replace(/\s*$/, '')}\n${line}\n`;
  }
}

const allowedOrigins = new Set(
  readValue('ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
allowedOrigins.add(publicOrigin);
setValue('ALLOWED_ORIGINS', [...allowedOrigins].join(','));

if (!readValue('VAPID_PUBLIC_KEY') || !readValue('VAPID_PRIVATE_KEY')) {
  const vapid = webPush.generateVAPIDKeys();
  setValue('VAPID_PUBLIC_KEY', vapid.publicKey);
  setValue('VAPID_PRIVATE_KEY', vapid.privateKey);
}

setValue('VAPID_EMAIL', `mailto:${emailArg}`);
fs.writeFileSync(envPath, source, { mode: 0o600 });
try {
  fs.chmodSync(envPath, 0o600);
} catch {
  // Windows ACLs are handled separately; chmod is effective on Linux.
}

console.log('PWA origin and Web Push credentials are configured. Existing model settings were preserved.');
