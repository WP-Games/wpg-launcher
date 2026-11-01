/**
 * Stateless, encrypted tokens (AES-256-GCM via WebCrypto).
 *
 * The launcher token the Worker hands out is an encrypted JSON blob: the
 * player's account summary plus their provider tokens, so we can re-check
 * their tier later without a database. Only this Worker (with SESSION_SECRET)
 * can read or forge one. The same helper protects the OAuth `state` param.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

let keyCache = null;
async function key(secret) {
  if (keyCache && keyCache.secret === secret) return keyCache.key;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const k = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  keyCache = { secret, key: k };
  return k;
}

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function seal(secret, payload) {
  const k = await key(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(JSON.stringify(payload)));
  return `${b64u(iv)}.${b64u(ct)}`;
}

/** Returns the payload, or null if the token is malformed/tampered/expired. */
export async function open(secret, token) {
  try {
    const [ivs, cts] = String(token || "").split(".");
    if (!ivs || !cts) return null;
    const k = await key(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(ivs) }, k, unb64u(cts));
    const payload = JSON.parse(dec.decode(pt));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
