import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, signBytes, verifyBytes } from "./signing.mjs";

test("sign/verify round-trip and tamper detection", () => {
  const k = generate();
  const data = Buffer.from('{"gameId":"x","version":"1"}');
  const sig = signBytes(k.privateKeyPem, data);
  assert.equal(verifyBytes(k.publicKeyB64, data, sig), true);
  assert.equal(verifyBytes(k.publicKeyB64, Buffer.from('{"gameId":"x","version":"2"}'), sig), false);
  const other = generate();
  assert.equal(verifyBytes(other.publicKeyB64, data, sig), false);
  assert.equal(Buffer.from(k.publicKeyB64, "base64").length, 32);
});
