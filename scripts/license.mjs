#!/usr/bin/env node
// Issues audio-viz Pro license keys, signed with Ed25519. The page checks the
// signature with the public key in www/license.js, so no server is needed.
//
//   node scripts/license.mjs keygen [private-key-path]
//       creates a key pair (once), prints the public key for www/license.js
//   node scripts/license.mjs issue <name-or-order-id> [months] [private-key-path]
//       prints a key; months = subscription length (omit or 0 = no expiry)
//
// The private key is kept outside the repository (default below). Never commit it.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_KEY = join(homedir(), '.config', 'audio-viz', 'license-private.pem');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'keygen') {
  const path = args[0] ?? DEFAULT_KEY;
  if (existsSync(path)) {
    console.error(`${path} already exists; delete it first if you really want a new key (old licenses stop working).`);
    process.exit(1);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  console.log(`private key: ${path}`);
  console.log(`PUBLIC_KEY for www/license.js: '${b64url(raw)}'`);
} else if (cmd === 'issue') {
  const [who, months = '0', path = DEFAULT_KEY] = args;
  if (!who) {
    console.error('usage: node scripts/license.mjs issue <name-or-order-id> [months] [private-key-path]');
    process.exit(1);
  }
  const key = createPrivateKey(readFileSync(path));
  const exp = +months > 0 ? new Date(Date.now() + +months * 30.44 * 864e5).toISOString().slice(0, 10) : null;
  const payload = { id: randomUUID().slice(0, 8), who, plan: 'pro', exp };
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(body), key);
  console.log(`AVZ1.${body}.${b64url(sig)}`);
} else {
  console.error('commands: keygen [path] | issue <name> [months] [path]');
  process.exit(1);
}
