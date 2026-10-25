import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { getHubSpotApiConfig } from "../lib/config.js";
import {
  fetchHubSpotContacts,
  HubSpotApiError,
} from "../lib/hubspotApi.js";
import type { HubSpotContactsPage } from "../lib/hubspotApi.js";
import {
  forceRefreshHubSpotAccessToken,
  getValidHubSpotAccessToken,
} from "./hubspotTokens.js";

export type ContactSyncStatus =
  | "IDLE"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "AUTH_REQUIRED";

export interface ContactSyncSummary {
  status: ContactSyncStatus;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  cursor: string | null;
  error?: string;
}

interface SyncCounters {
  processed: number;
  created: number;
  updated: number;
  failed: number;
}

function summary(
  status: ContactSyncStatus,
  counters: SyncCounters,
  cursor: string | null,
  error?: string,
): ContactSyncSummary {
  return {
    status,
    ...counters,
    cursor,
    ...(error ? { error } : {}),
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AppError && error.code === "HUBSPOT_AUTH_REQUIRED") {
    return "HubSpot authorization is required; reconnect the account.";
  }

  if (error instanceof HubSpotApiError) {
    return "HubSpot temporarily rejected the synchronization request. Retry later.";
  }

  return "Contact synchronization failed. Retry later.";
}

export async function processContactSyncJob(
  syncJobId: string,
  connectionId: string,
): Promise<ContactSyncSummary> {
  const [job, connection] = await Promise.all([
    prisma.syncJob.findUnique({
      where: { id: syncJobId },
      select: {
        id: true,
        status: true,
        cursor: true,
        processed: true,
        createdCount: true,
        updatedCount: true,
        failedCount: true,
        attempts: true,
        connectionId: true,
      },
    }),
    prisma.hubSpotConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, syncCursor: true },
    }),
  ]);

  if (!job || job.connectionId !== connectionId) {
    throw new AppError(404, "Synchronization job was not found", "NOT_FOUND");
  }

  if (!connection) {
    throw new AppError(404, "HubSpot connection was not found", "NOT_FOUND");
  }

  const counters: SyncCounters = {
    processed: job.processed,
    created: job.createdCount,
    updated: job.updatedCount,
    failed: job.failedCount,
  };
  let cursor = job.cursor ?? connection.syncCursor;
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
    prisma.hubSpotConnection.update({
      where: { id: connectionId },
      data: { syncStatus: "RUNNING" },
    }),
  ]);

  try {
    const apiConfig = getHubSpotApiConfig();

    while (true) {
      const pageCursor = cursor;
      let accessToken = await getValidHubSpotAccessToken(connectionId);
      let page: HubSpotContactsPage;

      try {
        page = await fetchHubSpotContacts(
          apiConfig.apiBaseUrl,
          accessToken,
          pageCursor ?? undefined,
        );
      } catch (error) {
        if (!(error instanceof HubSpotApiError) || error.status !== 401) {
          throw error;
        }

        accessToken = await forceRefreshHubSpotAccessToken(connectionId);
        page = await fetchHubSpotContacts(
          apiConfig.apiBaseUrl,
          accessToken,
          pageCursor ?? undefined,
        );
      }

      let pageFailed = 0;
      for (const contact of page.results) {
        try {
          const uniqueWhere = {
            connectionId_hubspotContactId: {
              connectionId,
              hubspotContactId: contact.id,
            },
          };
          const existing = await prisma.contact.findUnique({
            where: uniqueWhere,
            select: { id: true },
          });
          const properties = contact.properties;

          await prisma.contact.upsert({
            where: uniqueWhere,
            create: {
              connectionId,
              hubspotContactId: contact.id,
              email: properties.email ?? null,
              firstName: properties.firstname ?? null,
              lastName: properties.lastname ?? null,
              properties,
            },
            update: {
              email: properties.email ?? null,
              firstName: properties.firstname ?? null,
              lastName: properties.lastname ?? null,
              properties,
            },
          });

          counters.processed += 1;
          if (existing) {
            counters.updated += 1;
          } else {
            counters.created += 1;
          }
        } catch {
          pageFailed += 1;
          counters.failed += 1;
        }
      }

      const nextCursor = page.paging?.next?.after ?? null;
      cursor = pageFailed > 0 ? pageCursor : nextCursor;
      await prisma.$transaction([
        prisma.syncJob.update({
          where: { id: syncJobId },
          data: {
            cursor,
            processed: counters.processed,
            createdCount: counters.created,
            updatedCount: counters.updated,
            failedCount: counters.failed,
            ...(pageFailed > 0 ? { error: "Some contacts could not be persisted." } : {}),
          },
        }),
        prisma.hubSpotConnection.update({
          where: { id: connectionId },
          data: { syncCursor: cursor },
        }),
      ]);

      if (pageFailed > 0) {
        await prisma.$transaction([
          prisma.syncJob.update({
            where: { id: syncJobId },
            data: {
              status: "PARTIAL",
              completedAt: new Date(),
              dedupeKey: null,
            },
          }),
          prisma.hubSpotConnection.update({
            where: { id: connectionId },
            data: { syncStatus: "PARTIAL" },
          }),
        ]);

        return summary(
          "PARTIAL",
          counters,
          cursor,
          "Some contacts could not be persisted; retrying this page is safe.",
        );
      }

      if (!cursor) {
        await prisma.$transaction([
          prisma.syncJob.update({
            where: { id: syncJobId },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              error: null,
              dedupeKey: null,
            },
          }),
          prisma.hubSpotConnection.update({
            where: { id: connectionId },
            data: {
              syncStatus: "IDLE",
              lastSyncAt: new Date(),
              syncCursor: null,
            },
          }),
        ]);

        return summary("COMPLETED", counters, null);
      }
    }
  } catch (error) {
    const authRequired =
      error instanceof AppError && error.code === "HUBSPOT_AUTH_REQUIRED";
    const status: ContactSyncStatus = authRequired ? "AUTH_REQUIRED" : "RUNNING";
    const errorMessage = safeErrorMessage(error);

    await prisma.$transaction([
      prisma.syncJob.update({
        where: { id: syncJobId },
        data: { error: errorMessage },
      }),
      prisma.hubSpotConnection.update({
        where: { id: connectionId },
        data: {
          syncStatus: status,
          syncCursor: cursor,
        },
      }),
    ]);

    throw error;
  }
}
