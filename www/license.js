// Pro license: everything works for free; Pro only removes the small watermark
// from exports. A key is `AVZ1.<payload>.<signature>`, signed with Ed25519 by
// scripts/license.mjs and checked here with the public key, offline. No account,
// no server, nothing is sent anywhere.

/** Public half of the signing key (see scripts/license.mjs keygen). */
const PUBLIC_KEY = 'sIeyl9O3C0n13twEqPaLWt3NZ3-niMCXnfbjqyORiQ4';
/** Where "Купить Pro" leads (a checkout page). Empty = the button is hidden. */
export const CHECKOUT_URL = '';

const STORE = 'audio-viz.license';
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Verifies a key. Resolves to its payload ({ who, plan, exp }) or throws with a reason. */
export async function verify(key) {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'AVZ1') throw new Error('это не ключ audio-viz');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    throw new Error('ключ повреждён');
  }
  let ok;
  try {
    const pub = await crypto.subtle.importKey('raw', fromB64url(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, fromB64url(parts[2]), new TextEncoder().encode(parts[1]));
  } catch {
    throw new Error('браузер не умеет проверять ключи (нужен Ed25519 в WebCrypto); обновите браузер');
  }
  if (!ok) throw new Error('ключ не подходит');
  if (payload.exp && new Date(`${payload.exp}T23:59:59`) < new Date()) throw new Error(`срок ключа истёк ${payload.exp}`);
  return payload;
}

/** The saved license if it is still valid, else null. */
export async function current() {
  let key = null;
  try { key = localStorage.getItem(STORE); } catch {}
  if (!key) return null;
  try {
    return { key, ...(await verify(key)) };
  } catch {
    return null;
  }
}

export async function activate(key) {
  const payload = await verify(key);
  try { localStorage.setItem(STORE, key.trim()); } catch {}
  return payload;
}

export function deactivate() {
  try { localStorage.removeItem(STORE); } catch {}
}
