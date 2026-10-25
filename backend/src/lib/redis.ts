import { Redis } from "ioredis";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";

function getRedisUrl(): string {
  const value = process.env.REDIS_URL?.trim();
  if (!value) {
    throw new AppError(
      500,
      "Required environment variable REDIS_URL is missing",
      "CONFIGURATION_ERROR",
    );
  }

  return value;
}

export function createRedisConnection(
  options: { persistent?: boolean; failFast?: boolean; logErrors?: boolean } = {},
): Redis {
  const connection = new Redis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 3_000,
    retryStrategy: options.failFast
      ? () => null
      : options.persistent
        ? (times: number) => Math.min(times * 1_000, 10_000)
        : (times: number) => (times > 5 ? null : Math.min(times * 250, 1_000)),
  });

  if (options.logErrors !== false) {
    connection.on("error", (error: Error) => {
      const redisError = error as Error & { code?: string };
      if (redisError.message === "Connection is closed.") {
        return;
      }

      logger.error("redis_connection_error", {
        name: redisError.name,
        code: redisError.code ?? null,
        message: redisError.message || "Redis connection failed without a message",
      });
    });
  } else {
    // ioredis requires an error listener even when the caller handles startup
    // failure explicitly; otherwise Node reports an unhandled error event.
    connection.on("error", () => undefined);
  }

  return connection;
}
