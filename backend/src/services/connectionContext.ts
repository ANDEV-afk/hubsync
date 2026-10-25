import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

export async function requireSingleHubSpotConnection() {
  const connections = await prisma.hubSpotConnection.findMany({
    select: {
      id: true,
      hubspotPortalId: true,
      syncStatus: true,
      lastSyncAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (connections.length === 0) {
    throw new AppError(
      404,
      "No HubSpot account is connected",
      "HUBSPOT_NOT_CONNECTED",
    );
  }

  if (connections.length > 1) {
    throw new AppError(
      409,
      "Multiple HubSpot accounts are connected. User authentication is required before selecting one.",
      "MULTIPLE_CONNECTIONS",
    );
  }

  const connection = connections[0];
  if (!connection) {
    throw new AppError(404, "No HubSpot account is connected", "HUBSPOT_NOT_CONNECTED");
  }

  return connection;
}
