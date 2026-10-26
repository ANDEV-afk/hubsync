import "dotenv/config";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import prisma from "./lib/prisma.js";
import { createRedisConnection } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { AppError } from "./lib/errors.js";
import { HubSpotApiError } from "./lib/hubspotApi.js";
import {
  CONTACT_SYNC_QUEUE,
  enqueuePendingNoteSyncs,
  type SyncJobData,
} from "./services/syncJobs.js";
import { processContactSyncJob } from "./services/contactSync.js";
import { isNoteSyncNonRetryable, processNoteSyncJob } from "./services/notes.js";
import { isHubSpotNotesSyncEnabled } from "./lib/config.js";

const configuredConcurrency = Number(process.env.SYNC_WORKER_CONCURRENCY ?? "1");
const concurrency = Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
  ? Math.min(configuredConcurrency, 10)
  : 1;

const redisConnection = createRedisConnection({ failFast: true, logErrors: false });

try {
  await Promise.race([
    redisConnection.connect(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Redis connection timed out after 5 seconds")), 5_000);
    }),
  ]);
} catch (error) {
  const startupMessage =
    error instanceof Error &&
    error.message &&
    error.message !== "Connection is closed."
      ? error.message
      : "Redis is unavailable. Start Redis or correct REDIS_URL.";

  logger.error("contact_sync_worker_startup_failed", {
    code: error instanceof Error && "code" in error ? String(error.code) : null,
    message: startupMessage,
  });
  redisConnection.removeAllListeners("error");
  redisConnection.disconnect();
  await prisma.$disconnect();
  process.exit(1);
}

async function markRetryOrFailure(
  job: Job<SyncJobData>,
  reason: string,
  error: unknown,
): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  const nonRetryable =
    (error instanceof AppError && error.code === "HUBSPOT_AUTH_REQUIRED") ||
    isNoteSyncNonRetryable(error);
  const isFinalAttempt = nonRetryable || job.attemptsMade + 1 >= maxAttempts;

  await prisma.syncJob.update({
    where: { id: job.data.syncJobId },
    data: {
      status: isFinalAttempt ? "FAILED" : "QUEUED",
      error: reason,
      ...(isFinalAttempt ? { completedAt: new Date() } : {}),
      ...(isFinalAttempt ? {} : { completedAt: null }),
      ...(isFinalAttempt ? { dedupeKey: null } : {}),
    },
  });

  if (isFinalAttempt) {
    const updates: Promise<unknown>[] = [
      prisma.hubSpotConnection.update({
        where: { id: job.data.connectionId },
        data: {
          syncStatus: error instanceof AppError && error.code === "HUBSPOT_AUTH_REQUIRED"
            ? "AUTH_REQUIRED"
            : "FAILED",
        },
      }),
    ];

    if ("noteId" in job.data && job.data.noteId) {
      updates.push(
        prisma.note.update({
          where: { id: job.data.noteId },
          data: {
            syncStatus: "FAILED",
            lastSyncError: reason,
          },
        }),
      );
    }

    await Promise.all(updates);
  }
}

const worker = new Worker<SyncJobData>(
  CONTACT_SYNC_QUEUE,
  async (job) => {
    logger.info("contact_sync_job_started", {
      jobId: job.id,
      syncJobId: job.data.syncJobId,
      connectionId: job.data.connectionId,
      attempt: job.attemptsMade + 1,
    });

    try {
      const syncJob = await prisma.syncJob.findUnique({
        where: { id: job.data.syncJobId },
        select: { type: true },
      });

      if (!syncJob) {
        throw new AppError(404, "Synchronization job was not found", "NOT_FOUND");
      }

      const result = syncJob.type === "NOTES"
        ? await processNoteSyncJob(
            job.data.syncJobId,
            "noteId" in job.data ? job.data.noteId : "",
            job.data.connectionId,
          )
        : await processContactSyncJob(
            job.data.syncJobId,
            job.data.connectionId,
          );

      logger.info("contact_sync_job_finished", {
        jobId: job.id,
        syncJobId: job.data.syncJobId,
        status: result.status,
        processed: "processed" in result ? result.processed : 1,
        failed: "failed" in result ? result.failed : 0,
      });

      return result;
    } catch (error) {
      const reason = error instanceof AppError && error.code === "HUBSPOT_AUTH_REQUIRED"
        ? "HubSpot authorization is required; reconnect the account."
        : "noteId" in job.data
          ? "HubSpot note synchronization failed; retry scheduled."
          : "Contact synchronization failed; retry scheduled.";

      await markRetryOrFailure(job, reason, error);
      logger.warn("contact_sync_job_retrying_or_failed", {
        jobId: job.id,
        syncJobId: job.data.syncJobId,
        attempt: job.attemptsMade + 1,
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        errorName: error instanceof Error ? error.name : "UnknownError",
        appErrorCode: error instanceof AppError ? error.code : null,
        hubspotStatus: error instanceof HubSpotApiError ? error.status : null,
        hubspotApiCode: error instanceof HubSpotApiError ? error.apiCode ?? null : null,
      });
      if (
        (error instanceof AppError && error.code === "HUBSPOT_AUTH_REQUIRED") ||
        isNoteSyncNonRetryable(error)
      ) {
        throw new UnrecoverableError("Synchronization error is not retryable");
      }

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  },
);

async function enqueuePendingNotesOnStartup(): Promise<void> {
  if (!isHubSpotNotesSyncEnabled()) {
    return;
  }

  const connections = await prisma.hubSpotConnection.findMany({
    select: { id: true },
  });

  for (const connection of connections) {
    const jobs = await enqueuePendingNoteSyncs(connection.id);
    if (jobs.length > 0) {
      logger.info("pending_note_syncs_queued", {
        connectionId: connection.id,
        count: jobs.length,
      });
    }
  }
}

void enqueuePendingNotesOnStartup().catch((error: unknown) => {
  logger.error("pending_note_sync_startup_failed", {
    message: error instanceof Error ? error.message : "Unknown error",
  });
});

worker.on("error", (error) => {
  logger.error("contact_sync_worker_error", {
    message: error.message,
  });
});

worker.on("failed", (job, error) => {
  logger.error("contact_sync_job_failed", {
    jobId: job?.id,
    message: error.message,
  });

  const stalledFailure = error.message.toLowerCase().includes("stalled");
  if (!job || (!stalledFailure && job.attemptsMade < (job.opts.attempts ?? 1))) {
    return;
  }

  const updates: Promise<unknown>[] = [
    prisma.syncJob.update({
      where: { id: job.data.syncJobId },
      data: {
        status: "FAILED",
        error: "Contact synchronization failed after retries.",
        completedAt: new Date(),
        dedupeKey: null,
      },
    }),
    prisma.hubSpotConnection.update({
      where: { id: job.data.connectionId },
      data: { syncStatus: "FAILED" },
    }),
  ];

  if ("noteId" in job.data && job.data.noteId) {
    updates.push(
      prisma.note.update({
        where: { id: job.data.noteId },
        data: {
          syncStatus: "FAILED",
          lastSyncError: "HubSpot note synchronization failed after retries.",
        },
      }),
    );
  }

  void Promise.all(updates).catch((updateError: unknown) => {
    logger.error("contact_sync_failure_persistence_failed", {
      jobId: job.id,
      message: updateError instanceof Error ? updateError.message : "Unknown error",
    });
  });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info("contact_sync_worker_shutdown_started", { signal });

  await worker.close();
  await redisConnection.quit();
  await prisma.$disconnect();

  logger.info("contact_sync_worker_shutdown_completed");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("contact_sync_worker_started", { concurrency });
