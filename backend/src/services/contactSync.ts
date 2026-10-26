import prisma from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { randomUUID } from "node:crypto";
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

interface ContactPagePersistenceResult {
  created: number;
  updated: number;
  failed: number;
}

async function persistContactPage(
  connectionId: string,
  page: HubSpotContactsPage,
): Promise<ContactPagePersistenceResult> {
  if (page.results.length === 0) {
    return { created: 0, updated: 0, failed: 0 };
  }

  const contactIds = page.results.map((contact) => contact.id);
  const existingContacts = await prisma.contact.findMany({
    where: {
      connectionId,
      hubspotContactId: { in: contactIds },
    },
    select: { hubspotContactId: true },
  });
  const existingIds = new Set(
    existingContacts.map((contact) => contact.hubspotContactId),
  );

  const values = page.results.map((contact) => {
    const properties = contact.properties;
    return Prisma.sql`(
      ${randomUUID()},
      ${connectionId},
      ${contact.id},
      ${properties.email ?? null},
      ${properties.firstname ?? null},
      ${properties.lastname ?? null},
      ${JSON.stringify(properties)}::jsonb,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )`;
  });

  try {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "Contact" (
        "id",
        "connectionId",
        "hubspotContactId",
        "email",
        "firstName",
        "lastName",
        "properties",
        "createdAt",
        "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("connectionId", "hubspotContactId") DO UPDATE SET
        "email" = EXCLUDED."email",
        "firstName" = EXCLUDED."firstName",
        "lastName" = EXCLUDED."lastName",
        "properties" = EXCLUDED."properties",
        "updatedAt" = CURRENT_TIMESTAMP
    `);

    return {
      created: page.results.length - existingIds.size,
      updated: existingIds.size,
      failed: 0,
    };
  } catch {
    let created = 0;
    let updated = 0;
    let failed = 0;

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

        if (existing) {
          updated += 1;
        } else {
          created += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { created, updated, failed };
  }
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

      const pageResult = await persistContactPage(connectionId, page);
      const pageFailed = pageResult.failed;
      counters.processed += page.results.length - pageFailed;
      counters.created += pageResult.created;
      counters.updated += pageResult.updated;
      counters.failed += pageFailed;

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
