#!/usr/bin/env node
/**
 * keygen.mjs — create your manifest-signing key (once).
 *
 *   npm run keygen
 *
 * Writes the PRIVATE key to %USERPROFILE%\.wpg\manifest-signing.key (never
 * inside the project) and the PUBLIC key to src-tauri/signing.pub (committed,
 * compiled into the launcher). Refuses to overwrite an existing private key:
 * rotating keys means shipping a new launcher first, so it's deliberate.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, keyPath, rawPublicKeyB64 } from "./signing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pubPath = path.join(here, "..", "src-tauri", "signing.pub");
const priv = keyPath();

let pem;
try {
  pem = await fs.readFile(priv, "utf8");
  console.log(`Using existing private key at ${priv}`);
} catch {
  const k = generate();
  pem = k.privateKeyPem;
  await fs.mkdir(path.dirname(priv), { recursive: true });
  await fs.writeFile(priv, pem, { mode: 0o600 });
  console.log(`Created private key: ${priv}`);
  console.log("  → BACK THIS FILE UP somewhere offline (USB stick / password manager). Without it you can't publish.");
}
const pub = rawPublicKeyB64(pem);
await fs.writeFile(pubPath, pub + "\n");
console.log(`Public key written to src-tauri/signing.pub: ${pub}`);
console.log("Rebuild the launcher so it embeds this key, then publish/sync so catalog.json and manifests carry signatures.");
