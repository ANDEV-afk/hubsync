import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createRedisConnection } from "../lib/redis.js";

export const CONTACT_SYNC_QUEUE = "contact-sync";
export const CONTACT_SYNC_JOB_NAME = "sync-contacts";

export interface ContactSyncJobData {
  syncJobId: string;
  connectionId: string;
}

export interface NoteSyncJobData extends ContactSyncJobData {
  noteId: string;
}

export type SyncJobData = ContactSyncJobData | NoteSyncJobData;

let redisConnection: Redis | undefined;
let contactSyncQueue: Queue<SyncJobData> | undefined;

function ensureQueue(): Queue<SyncJobData> {
  if (!redisConnection) {
    redisConnection = createRedisConnection();
  }

  if (!contactSyncQueue) {
    contactSyncQueue = new Queue<SyncJobData>(CONTACT_SYNC_QUEUE, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 5_000 },
      },
    });
  }

  return contactSyncQueue;
}

async function waitForQueue(): Promise<Queue<SyncJobData>> {
  const queue = ensureQueue();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new AppError(503, "Synchronization queue is unavailable", "QUEUE_UNAVAILABLE"));
        }, 3_500);
      }),
    ]);
    return queue;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function ensureQueued(
  syncJobId: string,
  connectionId: string,
  noteId?: string,
): Promise<void> {
  const queue = await waitForQueue();
  const existingQueueJob = await queue.getJob(syncJobId);
  if (existingQueueJob) {
    return;
  }

  await queue.add(
    CONTACT_SYNC_JOB_NAME,
    noteId ? { syncJobId, connectionId, noteId } : { syncJobId, connectionId },
    { jobId: syncJobId },
  );
}

async function markContactQueueFailure(
  syncJobId: string,
  connectionId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: "FAILED",
        error: "Unable to enqueue synchronization job",
        completedAt: new Date(),
        dedupeKey: null,
      },
    }),
    prisma.hubSpotConnection.update({
      where: { id: connectionId },
      data: { syncStatus: "FAILED" },
    }),
  ]);
}

function deferContactQueue(syncJobId: string, connectionId: string): void {
  void ensureQueued(syncJobId, connectionId).catch(() =>
    markContactQueueFailure(syncJobId, connectionId).catch(() => undefined),
  );
}

async function markNoteQueueFailure(
  syncJobId: string,
  noteId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: "FAILED",
        error: "Unable to enqueue note synchronization job",
        completedAt: new Date(),
        dedupeKey: null,
      },
    }),
    prisma.note.update({
      where: { id: noteId },
      data: {
        syncStatus: "PENDING",
        lastSyncError: "Synchronization queue is unavailable; note remains local and pending.",
      },
    }),
  ]);
}

function deferNoteQueue(
  syncJobId: string,
  noteId: string,
  connectionId: string,
): void {
  void ensureQueued(syncJobId, connectionId, noteId).catch(() =>
    markNoteQueueFailure(syncJobId, noteId).catch(() => undefined),
  );
}

export function getContactSyncQueue(): Queue<SyncJobData> {
  return ensureQueue();
}

export async function enqueueContactSync(
  connectionId: string,
  options: { deferQueue?: boolean } = {},
) {
  const activeStatuses = ["QUEUED", "RUNNING"] as const;
  const dedupeKey = `contacts:${connectionId}`;
  const deferQueue = options.deferQueue === true;
  const existing = await prisma.syncJob.findFirst({
    where: {
      connectionId,
      type: "CONTACTS",
      status: { in: [...activeStatuses] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

  if (existing) {
    if (deferQueue) {
      deferContactQueue(existing.id, connectionId);
    } else {
      await ensureQueued(existing.id, connectionId);
    }

    return { ...existing, duplicate: true };
  }

  let syncJob;
  try {
    syncJob = await prisma.$transaction(async (transaction) => {
      const createdJob = await transaction.syncJob.create({
        data: {
          type: "CONTACTS",
          status: "QUEUED",
          connectionId,
          dedupeKey,
        },
        select: { id: true, status: true },
      });

      await transaction.hubSpotConnection.update({
        where: { id: connectionId },
        data: { syncStatus: "QUEUED" },
      });

      return createdJob;
    });
  } catch (error) {
    const retry = await prisma.syncJob.findFirst({
      where: {
        connectionId,
        type: "CONTACTS",
        status: { in: [...activeStatuses] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    if (retry) {
      return { ...retry, duplicate: true };
    }

    throw error;
  }

  try {
    if (deferQueue) {
      deferContactQueue(syncJob.id, connectionId);
    } else {
      await ensureQueued(syncJob.id, connectionId);
    }
  } catch (error) {
    await markContactQueueFailure(syncJob.id, connectionId);

    throw new AppError(503, "Synchronization queue is unavailable", "QUEUE_UNAVAILABLE");
  }

  return { ...syncJob, duplicate: false };
}

export async function enqueueNoteSync(
  noteId: string,
  connectionId: string,
  options: { deferQueue?: boolean } = {},
) {
  const dedupeKey = `notes:${noteId}`;
  const deferQueue = options.deferQueue === true;
  const existing = await prisma.syncJob.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true },
  });

  if (existing && (existing.status === "QUEUED" || existing.status === "RUNNING")) {
    if (deferQueue) {
      deferNoteQueue(existing.id, noteId, connectionId);
    } else {
      await ensureQueued(existing.id, connectionId, noteId);
    }

    return { ...existing, duplicate: true };
  }

  let syncJob;
  try {
    syncJob = await prisma.syncJob.create({
      data: {
        type: "NOTES",
        status: "QUEUED",
        connectionId,
        dedupeKey,
      },
      select: { id: true, status: true },
    });
  } catch (error) {
    const retry = await prisma.syncJob.findUnique({
      where: { dedupeKey },
      select: { id: true, status: true },
    });

    if (retry && (retry.status === "QUEUED" || retry.status === "RUNNING")) {
      return { ...retry, duplicate: true };
    }

    throw error;
  }

  try {
    if (deferQueue) {
      deferNoteQueue(syncJob.id, noteId, connectionId);
    } else {
      await ensureQueued(syncJob.id, connectionId, noteId);
    }
  } catch {
    await markNoteQueueFailure(syncJob.id, noteId);

    throw new AppError(503, "Synchronization queue is unavailable", "QUEUE_UNAVAILABLE");
  }

  return { ...syncJob, duplicate: false };
}

export async function enqueuePendingNoteSyncs(connectionId: string) {
  const pendingNotes = await prisma.note.findMany({
    where: {
      syncStatus: "PENDING",
      hubspotNoteId: null,
      contact: { connectionId },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const jobs = [];
  for (const note of pendingNotes) {
    jobs.push(await enqueueNoteSync(note.id, connectionId));
  }

  return jobs;
}

export async function getSyncJobStatus(syncJobId: string, connectionId: string) {
  const job = await prisma.syncJob.findUnique({
    where: { id: syncJobId },
    select: {
      id: true,
      type: true,
      status: true,
      connectionId: true,
      processed: true,
      createdCount: true,
      updatedCount: true,
      failedCount: true,
      attempts: true,
      cursor: true,
      error: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!job) {
    throw new AppError(404, "Synchronization job was not found", "NOT_FOUND");
  }

  if (job.connectionId !== connectionId) {
    throw new AppError(404, "Synchronization job was not found", "NOT_FOUND");
  }

  const { connectionId: _connectionId, ...publicJob } = job;
  return publicJob;
}

export async function closeSyncQueue(): Promise<void> {
  if (contactSyncQueue) {
    await contactSyncQueue.close();
    contactSyncQueue = undefined;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = undefined;
  }
}
