import { Router } from "express";
import { AppError } from "../lib/errors.js";
import { isHubSpotNotesSyncEnabled } from "../lib/config.js";
import { requireSingleHubSpotConnection } from "../services/connectionContext.js";
import {
  createLocalNote,
  findContactForConnection,
  listNotesForContact,
  validateNoteBody,
} from "../services/notes.js";
import { enqueueNoteSync } from "../services/syncJobs.js";
import prisma from "../lib/prisma.js";

const router = Router();

function contactIdFromParams(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new AppError(400, "contactId is invalid", "VALIDATION_ERROR");
  }

  return value;
}

router.post("/contacts/:contactId/notes", async (request, response, next) => {
  try {
    const contactId = contactIdFromParams(request.params.contactId);
    const body = validateNoteBody(request.body?.body);
    const connection = await requireSingleHubSpotConnection();
    const note = await createLocalNote(contactId, connection.id, body);

    if (!isHubSpotNotesSyncEnabled()) {
      response.status(201).json({
        success: true,
        data: {
          note,
          sync: {
            status: note.syncStatus,
            queued: false,
            reason: "HUBSPOT_NOTES_SYNC_DISABLED",
          },
        },
      });
      return;
    }

    try {
      const job = await enqueueNoteSync(note.id, connection.id, { deferQueue: true });
      response.status(201).json({
        success: true,
        data: {
          note,
          sync: {
            status: note.syncStatus,
            queued: true,
            jobId: job.id,
            duplicate: job.duplicate,
          },
        },
      });
    } catch (error) {
      await prisma.note.update({
        where: { id: note.id },
        data: {
          syncStatus: "PENDING",
          lastSyncError: "Synchronization queue is unavailable; note remains local and pending.",
        },
      });

      if (error instanceof AppError && error.code === "QUEUE_UNAVAILABLE") {
        response.status(201).json({
          success: true,
          data: {
            note: {
              ...note,
              lastSyncError: "Synchronization queue is unavailable; note remains local and pending.",
            },
            sync: {
              status: "PENDING",
              queued: false,
              reason: "QUEUE_UNAVAILABLE",
            },
          },
        });
        return;
      }

      throw error;
    }
  } catch (error) {
    next(error);
  }
});

router.get("/contacts/:contactId/notes", async (request, response, next) => {
  try {
    const contactId = contactIdFromParams(request.params.contactId);
    const connection = await requireSingleHubSpotConnection();
    await findContactForConnection(contactId, connection.id);
    const notes = await listNotesForContact(contactId, connection.id);

    response.json({
      success: true,
      data: { notes },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
