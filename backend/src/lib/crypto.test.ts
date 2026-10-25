import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptToken, encryptToken } from "./crypto.js";

test("encryptToken and decryptToken round-trip without storing plaintext", () => {
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  const token = "hubspot-access-token-for-tests";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  try {
    const encrypted = encryptToken(token);
    assert.notEqual(encrypted, token);
    assert.equal(decryptToken(encrypted), token);
    assert.throws(() => decryptToken(`${encrypted}tampered`));
  } finally {
    if (previousKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    }
  }
});
