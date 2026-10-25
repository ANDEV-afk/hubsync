import { Router } from "express";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { requireSingleHubSpotConnection } from "../services/connectionContext.js";
import { enqueueContactSync, getSyncJobStatus } from "../services/syncJobs.js";

const router = Router();

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AppError(400, `${name} must be a positive integer`, "VALIDATION_ERROR");
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AppError(
      400,
      `${name} must be between 1 and ${maximum}`,
      "VALIDATION_ERROR",
    );
  }

  return parsed;
}

function parseSearch(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length > 100) {
    throw new AppError(
      400,
      "search must be a string with at most 100 characters",
      "VALIDATION_ERROR",
    );
  }

  return value.trim() || undefined;
}

router.post("/sync/contacts", async (_request, response, next) => {
  try {
    const connection = await requireSingleHubSpotConnection();
    const job = await enqueueContactSync(connection.id);

    response.status(202).json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        duplicate: job.duplicate,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/sync/jobs/:jobId", async (request, response, next) => {
  try {
    const jobId = request.params.jobId;
    if (!jobId || jobId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(jobId)) {
      throw new AppError(400, "jobId is invalid", "VALIDATION_ERROR");
    }

    const connection = await requireSingleHubSpotConnection();
    const job = await getSyncJobStatus(jobId, connection.id);
    response.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

router.get("/contacts", async (request, response, next) => {
  try {
    const connection = await requireSingleHubSpotConnection();
    const page = parsePositiveInteger(request.query.page, 1, 1_000_000, "page");
    const limit = parsePositiveInteger(request.query.limit, 25, 100, "limit");
    const search = parseSearch(request.query.search);

    const where = { connectionId: connection.id,...(search ? {
            OR: [
              { email: { contains: search, mode: "insensitive" as const } },
              { firstName: { contains: search, mode: "insensitive" as const } },
              { lastName: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [contacts, total] = await prisma.$transaction([
      prisma.contact.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          hubspotContactId: true,
          email: true,
          firstName: true,
          lastName: true,
          properties: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.contact.count({ where }),
    ]);

    response.json({
      success: true,
      data: {
        contacts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
