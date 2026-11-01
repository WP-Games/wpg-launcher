/**
 * signing.mjs — Ed25519 signatures for catalog.json and every manifest.json.
 *
 * Why: the launcher must refuse to install anything that wasn't signed with
 * YOUR key, even if someone gets into the Cloudflare account or the bucket.
 * The private key never leaves your PC; the public key is compiled into the
 * launcher (src-tauri/signing.pub). No identity, CA or registration involved.
 *
 * Key location (private): %USERPROFILE%\<launcher.keyDir>\manifest-signing.key
 *   — or wherever LAUNCHER_SIGNING_KEY points. Back it up somewhere safe and
 *   offline: lose it and you must ship a new launcher before any new game
 *   version can be installed.
 *
 * Signature files are detached: `<file>.sig` holds base64(ed25519(bytes of <file>)).
 */
import { promises as fs } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import path from "node:path";
import { keyDir } from "./config.mjs";

export const DEFAULT_KEY_PATH = path.join(keyDir, "manifest-signing.key");
export const keyPath = () => process.env.LAUNCHER_SIGNING_KEY || process.env.WPG_SIGNING_KEY || DEFAULT_KEY_PATH;

/** Raw 32-byte Ed25519 public key as base64 — what gets embedded in the launcher. */
export function rawPublicKeyB64(privateKeyPem) {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  const spki = pub.export({ type: "spki", format: "der" }); // 12-byte prefix + 32-byte key
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

export function generate() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return { privateKeyPem: pem, publicKeyB64: rawPublicKeyB64(pem) };
}

export async function loadPrivateKey() {
  const p = keyPath();
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    throw new Error(`No signing key at ${p}. Run: npm run keygen   (or set LAUNCHER_SIGNING_KEY)`);
  }
}

export function signBytes(privateKeyPem, bytes) {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyBytes(publicKeyB64, bytes, signatureB64) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64")]);
  const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, bytes, pub, Buffer.from(signatureB64, "base64"));
}

/** Sign a file on disk, writing `<file>.sig` beside it. Returns the signature. */
export async function signFile(privateKeyPem, filePath) {
  const bytes = await fs.readFile(filePath);
  const sig = signBytes(privateKeyPem, bytes);
  await fs.writeFile(`${filePath}.sig`, sig);
  return sig;
}
