import assert from "node:assert/strict";
import test from "node:test";
import { consumeOAuthState, issueOAuthState } from "./oauthState.js";

test("OAuth state is single-use", () => {
  const state = issueOAuthState();
  assert.equal(consumeOAuthState(state), true);
  assert.equal(consumeOAuthState(state), false);
});
