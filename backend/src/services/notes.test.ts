import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import app from "../app.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { HubSpotApiError } from "../lib/hubspotApi.js";
import { isNoteSyncNonRetryable, isNoteSyncTransient, validateNoteBody } from "./notes.js";

interface HttpResponse {
  status: number;
  body: unknown;
}

async function requestApp(
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  const server = app.listen(0);

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Test server did not expose a port");
  }

  try {
    return await new Promise<HttpResponse>((resolve, reject) => {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      const requestHandle = request(
        {
          method,
          port: address.port,
          host: "127.0.0.1",
          path,
          headers: serialized
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(serialized),
              }
            : undefined,
        },
        (response) => {
          let responseBody = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            responseBody += chunk;
          });
          response.on("end", () => {
            let parsed: unknown = responseBody;
            try {
              parsed = JSON.parse(responseBody) as unknown;
            } catch {
              // Keep non-JSON response bodies available to the assertion.
            }
            resolve({ status: response.statusCode ?? 0, body: parsed });
          });
        },
      );

      requestHandle.on("error", reject);
      if (serialized) {
        requestHandle.write(serialized);
      }
      requestHandle.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const connection = {
  id: "connection-1",
  hubspotPortalId: "12345",
  syncStatus: "IDLE",
  lastSyncAt: null,
};

const note = {
  id: "note-1",
  contactId: "contact-1",
  body: "Call completed",
  hubspotNoteId: null,
  syncStatus: "PENDING",
  lastSyncError: null,
  syncedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

test("validateNoteBody rejects empty and oversized notes", () => {
  assert.throws(() => validateNoteBody("   "), (error: unknown) => {
    return error instanceof AppError && error.code === "VALIDATION_ERROR";
  });
  assert.throws(() => validateNoteBody("x".repeat(65_537)), (error: unknown) => {
    return error instanceof AppError && error.code === "VALIDATION_ERROR";
  });
  assert.equal(validateNoteBody("  hello  "), "hello");
});

test("creating a note persists it locally and keeps it pending when HubSpot notes sync is disabled", async () => {
  const previousFlag = process.env.HUBSPOT_NOTES_SYNC_ENABLED;
  delete process.env.HUBSPOT_NOTES_SYNC_ENABLED;

  const originalFindConnections = prisma.hubSpotConnection.findMany;
  const originalFindContact = prisma.contact.findFirst;
  const originalCreateNote = prisma.note.create;
  let findConnectionsCalls = 0;
  let findContactCalls = 0;
  let createNoteCalls = 0;
  prisma.hubSpotConnection.findMany = (async () => {
    findConnectionsCalls += 1;
    return [connection];
  }) as typeof originalFindConnections;
  prisma.contact.findFirst = (async () => {
    findContactCalls += 1;
    return { id: "contact-1", connectionId: "connection-1" };
  }) as typeof originalFindContact;
  prisma.note.create = (async () => {
    createNoteCalls += 1;
    return note;
  }) as unknown as typeof originalCreateNote;

  try {
    const response = await requestApp("POST", "/api/contacts/contact-1/notes", {
      body: "Call completed",
    });
    const body = response.body as { data: { note: typeof note; sync: { queued: boolean; status: string } } };

    assert.equal(response.status, 201);
    assert.equal(body.data.note.syncStatus, "PENDING");
    assert.equal(body.data.sync.status, "PENDING");
    assert.equal(body.data.sync.queued, false);
    assert.equal(createNoteCalls, 1);
    assert.equal(findConnectionsCalls, 1);
    assert.equal(findContactCalls, 1);
  } finally {
    prisma.hubSpotConnection.findMany = originalFindConnections;
    prisma.contact.findFirst = originalFindContact;
    prisma.note.create = originalCreateNote;
    if (previousFlag === undefined) {
      delete process.env.HUBSPOT_NOTES_SYNC_ENABLED;
    } else {
      process.env.HUBSPOT_NOTES_SYNC_ENABLED = previousFlag;
    }
  }
});

test("retrieving notes validates contact ownership and returns local notes", async () => {
  const originalFindConnections = prisma.hubSpotConnection.findMany;
  const originalFindContact = prisma.contact.findFirst;
  const originalFindNotes = prisma.note.findMany;
  let findConnectionsCalls = 0;
  let findContactCalls = 0;
  let findNotesCalls = 0;
  prisma.hubSpotConnection.findMany = (async () => {
    findConnectionsCalls += 1;
    return [connection];
  }) as typeof originalFindConnections;
  prisma.contact.findFirst = (async () => {
    findContactCalls += 1;
    return { id: "contact-1", connectionId: "connection-1" };
  }) as typeof originalFindContact;
  prisma.note.findMany = (async () => {
    findNotesCalls += 1;
    return [note];
  }) as typeof originalFindNotes;

  try {
    const response = await requestApp("GET", "/api/contacts/contact-1/notes");
    const body = response.body as { data: { notes: typeof note[] } };

    assert.equal(response.status, 200);
    assert.equal(body.data.notes.length, 1);
    assert.equal(body.data.notes[0]?.syncStatus, "PENDING");
    assert.equal(findConnectionsCalls, 1);
    assert.equal(findContactCalls, 2);
    assert.equal(findNotesCalls, 1);
  } finally {
    prisma.hubSpotConnection.findMany = originalFindConnections;
    prisma.contact.findFirst = originalFindContact;
    prisma.note.findMany = originalFindNotes;
  }
});

test("note synchronization classifies permission failures as permanent and rate limits as transient", () => {
  assert.equal(
    isNoteSyncNonRetryable(new AppError(403, "permission", "NOTE_SYNC_PERMISSION_REQUIRED")),
    true,
  );
  assert.equal(isNoteSyncTransient(new HubSpotApiError(429, "RATE_LIMIT")), true);
  assert.equal(isNoteSyncTransient(new HubSpotApiError(403, "FORBIDDEN")), false);
});
