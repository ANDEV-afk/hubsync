import "dotenv/config";
import type { Server } from "node:http";
import app from "./app.js";
import prisma from "./lib/prisma.js";
import { closeSyncQueue } from "./services/syncJobs.js";

const PORT = process.env.PORT || 4000;
let server: Server | undefined;
let shuttingDown = false;

server = app.listen(PORT, () => {
  console.log(`HubSync API running on port ${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`HubSync API shutting down after ${signal}`);

  try {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await closeSyncQueue();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "api_shutdown_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
