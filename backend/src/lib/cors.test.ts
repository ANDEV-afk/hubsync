import assert from "node:assert/strict";
import test from "node:test";
import { getAllowedCorsOrigins } from "./cors.js";

test("local frontend origins are interchangeable for development CORS", () => {
  const origins = getAllowedCorsOrigins("https://hubsync-fe.vercel.app/");

  assert.equal(origins.has("https://hubsync-fe.vercel.app/"), true);
  assert.equal(origins.has("https://hubsync-fe.vercel.app/"), true);
  assert.equal(origins.has("https://hubsync-fe.vercel.app/"), true);
  assert.equal(origins.has("https://hubsync-fe.vercel.app/"), false);
});

test("non-local frontend configuration remains restricted to its origin", () => {
  const origins = getAllowedCorsOrigins("https://app.example.com");

  assert.deepEqual([...origins], ["https://app.example.com"]);
  assert.equal(origins.has("https://admin.example.com"), false);
});
