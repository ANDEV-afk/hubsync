import assert from "node:assert/strict";
import test from "node:test";
import { getAllowedCorsOrigins, isAllowedCorsOrigin } from "./cors.js";

test("the configured frontend origin is allowed", () => {
  const origins = getAllowedCorsOrigins("https://hubsync-fe.vercel.app/");

  assert.equal(
    isAllowedCorsOrigin("https://hubsync-fe.vercel.app", origins),
    true,
  );
});

test("loopback development origins are allowed on any port", () => {
  const origins = getAllowedCorsOrigins("https://hubsync-fe.vercel.app/");

  for (const origin of [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "https://localhost:4000",
  ]) {
    assert.equal(isAllowedCorsOrigin(origin, origins), true, origin);
  }
});

test("unconfigured non-loopback origins are rejected", () => {
  const origins = getAllowedCorsOrigins("https://app.example.com");

  assert.deepEqual([...origins], ["https://app.example.com"]);
  assert.equal(isAllowedCorsOrigin("https://admin.example.com", origins), false);
  assert.equal(isAllowedCorsOrigin("http://evil.example.com", origins), false);
});

test("requests without an Origin header are allowed", () => {
  const origins = getAllowedCorsOrigins("https://app.example.com");

  assert.equal(isAllowedCorsOrigin(undefined, origins), true);
});
