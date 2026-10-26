import assert from "node:assert/strict";
import test from "node:test";
import {
  createHubSpotNote,
  fetchHubSpotContacts,
  HubSpotApiError,
  hubspotRequest,
  parseContactsPage,
} from "./hubspotApi.js";

test("contact page parser preserves HubSpot properties and cursor", () => {
  const page = parseContactsPage({
    results: [
      {
        id: "123",
        properties: {
          email: "person@example.com",
          firstname: "Ada",
          lastname: "Lovelace",
        },
      },
    ],
    paging: { next: { after: "456" } },
  });

  assert.equal(page.results[0]?.id, "123");
  assert.equal(page.results[0]?.properties.email, "person@example.com");
  assert.equal(page.paging?.next?.after, "456");
});

test("fetchHubSpotContacts sends the pagination cursor and bearer token", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authorization = "";

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";

    return new Response(
      JSON.stringify({ results: [], paging: { next: { after: "next-page" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const page = await fetchHubSpotContacts(
      "https://api.hubapi.com",
      "test-access-token",
      "cursor-123",
    );

    const url = new URL(requestUrl);
    assert.equal(url.pathname, "/crm/v3/objects/contacts");
    assert.equal(url.searchParams.get("after"), "cursor-123");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(authorization, "Bearer test-access-token");
    assert.equal(page.paging?.next?.after, "next-page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hubspotRequest retries a rate-limit response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "RATE_LIMIT" }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const result = await hubspotRequest<{ ok: boolean }>(
      "https://api.hubapi.com/test",
      { method: "GET" },
      2,
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hubspotRequest does not retry non-transient authorization errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
    });
  };

  try {
    await assert.rejects(
      () => hubspotRequest("https://api.hubapi.com/test", { method: "GET" }),
      (error: unknown) => error instanceof HubSpotApiError && error.status === 401,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createHubSpotNote does not retry an ambiguous network failure", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("connection reset");
  };

  try {
    await assert.rejects(
      () =>
        createHubSpotNote(
          "https://api.hubapi.com",
          "test-access-token",
          "contact-123",
          "A local note",
          new Date("2026-01-01T00:00:00.000Z"),
        ),
      (error: unknown) =>
        error instanceof HubSpotApiError &&
        error.apiCode === "AMBIGUOUS_NETWORK_ERROR",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createHubSpotNote creates and associates a note with the HubSpot contact", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: unknown;

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "hubspot-note-123" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const noteId = await createHubSpotNote(
      "https://api.hubapi.com",
      "test-access-token",
      "contact-123",
      "A local note",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const body = requestBody as {
      properties: { hs_timestamp: string; hs_note_body: string };
      associations: Array<{
        to: { id: string };
        types: Array<{ associationCategory: string; associationTypeId: number }>;
      }>;
    };

    assert.equal(noteId, "hubspot-note-123");
    assert.equal(requestUrl, "https://api.hubapi.com/crm/v3/objects/notes");
    assert.deepEqual(body.properties, {
      hs_timestamp: "2026-01-01T00:00:00.000Z",
      hs_note_body: "A local note",
    });
    assert.deepEqual(body.associations, [
      {
        to: { id: "contact-123" },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 202,
          },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
