import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import {
  createHubSpotNote,
  HubSpotApiError,
} from "../lib/hubspotApi.js";
import { getHubSpotApiConfig, isHubSpotNotesSyncEnabled } from "../lib/config.js";
import { forceRefreshHubSpotAccessToken, getValidHubSpotAccessToken } from "./hubspotTokens.js";

const MAX_NOTE_LENGTH = 65_536;
const RETRYABLE_HUBSPOT_STATUSES = new Set([
  423, 429, 477, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526,
]);

export function validateNoteBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "body must be a string", "VALIDATION_ERROR");
  }

  const body = value.trim();
  if (!body) {
    throw new AppError(400, "body must not be empty", "VALIDATION_ERROR");
  }

  if (body.length > MAX_NOTE_LENGTH) {
    throw new AppError(
      400,
      `body must not exceed ${MAX_NOTE_LENGTH} characters`,
      "VALIDATION_ERROR",
    );
  }

  return body;
}

export function isNoteSyncNonRetryable(error: unknown): boolean {
  return (
    error instanceof AppError &&
    [
      "HUBSPOT_AUTH_REQUIRED",
      "HUBSPOT_NOTES_SYNC_DISABLED",
      "NOTE_SYNC_PERMISSION_REQUIRED",
      "NOTE_SYNC_AMBIGUOUS",
      "NOTE_SYNC_FAILED",
      "HUBSPOT_INVALID_RESPONSE",
    ].includes(error.code)
  );
}

export function isNoteSyncTransient(error: unknown): boolean {
  return error instanceof HubSpotApiError && RETRYABLE_HUBSPOT_STATUSES.has(error.status);
}

export async function findContactForConnection(
  contactId: string,
  connectionId: string,
) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, connectionId },
    select: { id: true, connectionId: true },
  });

  if (!contact) {
    throw new AppError(404, "Contact was not found", "NOT_FOUND");
  }

  return contact;
}

export async function createLocalNote(
  contactId: string,
  connectionId: string,
  body: string,
) {
  await findContactForConnection(contactId, connectionId);

  return prisma.note.create({
    data: {
      contactId,
      body,
      syncStatus: "PENDING",
      hubspotNoteId: null,
      lastSyncError: null,
      syncedAt: null,
    },
    select: {
      id: true,
      contactId: true,
      body: true,
      hubspotNoteId: true,
      syncStatus: true,
      lastSyncError: true,
      syncedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function listNotesForContact(
  contactId: string,
  connectionId: string,
) {
  await findContactForConnection(contactId, connectionId);

  return prisma.note.findMany({
    where: { contactId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      contactId: true,
      body: true,
      hubspotNoteId: true,
      syncStatus: true,
      lastSyncError: true,
      syncedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function processNoteSyncJob(
  syncJobId: string,
  noteId: string,
  connectionId: string,
) {
  const [job, note] = await Promise.all([
    prisma.syncJob.findUnique({
      where: { id: syncJobId },
      select: { id: true, type: true, connectionId: true, status: true },
    }),
    prisma.note.findUnique({
      where: { id: noteId },
      select: {
        id: true,
        body: true,
        contactId: true,
        hubspotNoteId: true,
        syncStatus: true,
        createdAt: true,
        contact: {
          select: { connectionId: true, hubspotContactId: true },
        },
      },
    }),
  ]);

  if (!job || job.type !== "NOTES" || job.connectionId !== connectionId) {
    throw new AppError(404, "Note synchronization job was not found", "NOT_FOUND");
  }

  if (!note || note.contact.connectionId !== connectionId) {
    throw new AppError(404, "Note was not found", "NOT_FOUND");
  }

  const startedAt = job.status === "RUNNING" ? {} : { startedAt: new Date() };

  await prisma.$transaction([
    prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        error: null,
        ...startedAt,
      },
    }),
    prisma.note.update({
      where: { id: noteId },
      data: { syncStatus: "PENDING", lastSyncError: null },
    }),
  ]);

  if (note.hubspotNoteId) {
    await completeNoteSync(syncJobId, noteId, note.hubspotNoteId);
    return { status: "COMPLETED", hubspotNoteId: note.hubspotNoteId } as const;
  }

  if (!isHubSpotNotesSyncEnabled()) {
    await failNoteSync(
      syncJobId,
      noteId,
      "HubSpot note synchronization is disabled because notes write permission is not configured.",
      "PENDING",
    );
    throw new AppError(
      503,
      "HubSpot note synchronization is not enabled",
      "HUBSPOT_NOTES_SYNC_DISABLED",
    );
  }

  try {
    const apiConfig = getHubSpotApiConfig();
    let accessToken = await getValidHubSpotAccessToken(connectionId);
    let hubspotNoteId: string;

    try {
      hubspotNoteId = await createHubSpotNote(
        apiConfig.apiBaseUrl,
        accessToken,
        note.contact.hubspotContactId,
        note.body,
        note.createdAt,
      );
    } catch (error) {
      if (!(error instanceof HubSpotApiError) || error.status !== 401) {
        throw error;
      }

      accessToken = await forceRefreshHubSpotAccessToken(connectionId);
      hubspotNoteId = await createHubSpotNote(
        apiConfig.apiBaseUrl,
        accessToken,
        note.contact.hubspotContactId,
        note.body,
        note.createdAt,
      );
    }

    await completeNoteSync(syncJobId, noteId, hubspotNoteId);
    return { status: "COMPLETED", hubspotNoteId } as const;
  } catch (error) {
    if (error instanceof HubSpotApiError && error.apiCode === "AMBIGUOUS_NETWORK_ERROR") {
      await failNoteSync(
        syncJobId,
        noteId,
        "The HubSpot note request may have reached HubSpot but no response was received. Automatic retry is disabled to avoid duplicate notes.",
        "FAILED",
      );
      throw new AppError(
        502,
        "HubSpot note synchronization has an ambiguous outcome",
        "NOTE_SYNC_AMBIGUOUS",
      );
    }

    if (error instanceof HubSpotApiError && RETRYABLE_HUBSPOT_STATUSES.has(error.status)) {
      await prisma.$transaction([
        prisma.syncJob.update({
          where: { id: syncJobId },
          data: { error: "Temporary HubSpot failure; note sync will be retried." },
        }),
        prisma.note.update({
          where: { id: noteId },
          data: {
            syncStatus: "PENDING",
            lastSyncError: "Temporary HubSpot failure; note sync will be retried.",
          },
        }),
      ]);
      throw error;
    }

    const message =
      error instanceof HubSpotApiError && (error.status === 401 || error.status === 403)
        ? "HubSpot notes permission is unavailable or authorization is no longer valid."
        : "HubSpot note synchronization failed permanently.";

    await failNoteSync(syncJobId, noteId, message, "FAILED");
    throw new AppError(
      error instanceof HubSpotApiError && error.status === 403 ? 403 : 502,
      message,
      error instanceof HubSpotApiError && error.status === 403
        ? "NOTE_SYNC_PERMISSION_REQUIRED"
        : "NOTE_SYNC_FAILED",
    );
  }
}

async function completeNoteSync(
  syncJobId: string,
  noteId: string,
  hubspotNoteId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.note.update({
      where: { id: noteId },
      data: {
        hubspotNoteId,
        syncStatus: "SYNCED",
        lastSyncError: null,
        syncedAt: new Date(),
      },
    }),
    prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: "COMPLETED",
        error: null,
        completedAt: new Date(),
        dedupeKey: null,
      },
    }),
  ]);
}

async function failNoteSync(
  syncJobId: string,
  noteId: string,
  message: string,
  noteStatus: "PENDING" | "FAILED",
): Promise<void> {
  await prisma.$transaction([
    prisma.note.update({
      where: { id: noteId },
      data: { syncStatus: noteStatus, lastSyncError: message },
    }),
    prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: noteStatus === "FAILED" ? "FAILED" : "RUNNING",
        error: message,
        ...(noteStatus === "FAILED" ? { completedAt: new Date(), dedupeKey: null } : {}),
      },
    }),
  ]);
}
