import assert from "node:assert/strict";
import test from "node:test";
import { getAllowedCorsOrigins } from "./cors.js";

test("local frontend origins are interchangeable for development CORS", () => {
  const origins = getAllowedCorsOrigins("http://localhost:5173");

  assert.equal(origins.has("http://localhost:5173"), true);
  assert.equal(origins.has("http://127.0.0.1:5173"), true);
  assert.equal(origins.has("http://[::1]:5173"), true);
  assert.equal(origins.has("http://localhost:5174"), false);
});

test("non-local frontend configuration remains restricted to its origin", () => {
  const origins = getAllowedCorsOrigins("https://app.example.com");

  assert.deepEqual([...origins], ["https://app.example.com"]);
  assert.equal(origins.has("https://admin.example.com"), false);
});
