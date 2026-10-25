import prisma from "../lib/prisma.js";
import { getHubSpotApiConfig } from "../lib/config.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import {
  HubSpotApiError,
  refreshHubSpotAccessToken,
} from "../lib/hubspotApi.js";

const EXPIRY_SKEW_MS = 60 * 1000;
const refreshesInFlight = new Map<string, Promise<string>>();

function parseExpiresAt(expiresIn: unknown): Date {
  const seconds =
    typeof expiresIn === "number"
      ? expiresIn
      : typeof expiresIn === "string"
        ? Number(expiresIn)
        : Number.NaN;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AppError(
      502,
      "HubSpot returned an invalid token expiration",
      "HUBSPOT_INVALID_TOKEN_RESPONSE",
    );
  }

  return new Date(Date.now() + seconds * 1000);
}

export async function getValidHubSpotAccessToken(
  connectionId: string,
): Promise<string> {
  const connection = await prisma.hubSpotConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
      tokenExpiresAt: true,
    },
  });

  if (!connection) {
    throw new AppError(404, "HubSpot connection was not found", "NOT_FOUND");
  }

  if (
    connection.tokenExpiresAt &&
    connection.tokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS
  ) {
    return decryptToken(connection.accessTokenEncrypted);
  }

  return refreshWithLock(connectionId, connection.refreshTokenEncrypted);
}

export async function forceRefreshHubSpotAccessToken(
  connectionId: string,
): Promise<string> {
  const connection = await prisma.hubSpotConnection.findUnique({
    where: { id: connectionId },
    select: { refreshTokenEncrypted: true },
  });

  if (!connection) {
    throw new AppError(404, "HubSpot connection was not found", "NOT_FOUND");
  }

  return refreshWithLock(connectionId, connection.refreshTokenEncrypted);
}

async function refreshWithLock(
  connectionId: string,
  encryptedRefreshToken: string,
): Promise<string> {
  const existingRefresh = refreshesInFlight.get(connectionId);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = refreshConnectionToken(
    connectionId,
    encryptedRefreshToken,
  );
  refreshesInFlight.set(connectionId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (refreshesInFlight.get(connectionId) === refreshPromise) {
      refreshesInFlight.delete(connectionId);
    }
  }
}

async function refreshConnectionToken(
  connectionId: string,
  encryptedRefreshToken: string,
): Promise<string> {
  const config = getHubSpotApiConfig();
  const refreshToken = decryptToken(encryptedRefreshToken);

  try {
    const tokenResponse = await refreshHubSpotAccessToken(
      config.apiBaseUrl,
      config.clientId,
      config.clientSecret,
      refreshToken,
    );

    const accessToken =
      typeof tokenResponse.access_token === "string"
        ? tokenResponse.access_token
        : undefined;
    const latestRefreshToken =
      typeof tokenResponse.refresh_token === "string"
        ? tokenResponse.refresh_token
        : refreshToken;

    if (!accessToken) {
      throw new AppError(
        502,
        "HubSpot did not return a refreshed access token",
        "HUBSPOT_INVALID_TOKEN_RESPONSE",
      );
    }

    await prisma.hubSpotConnection.update({
      where: { id: connectionId },
      data: {
        accessTokenEncrypted: encryptToken(accessToken),
        refreshTokenEncrypted: encryptToken(latestRefreshToken),
        tokenExpiresAt: parseExpiresAt(tokenResponse.expires_in),
        syncStatus: "IDLE",
      },
    });

    return accessToken;
  } catch (error) {
    const refreshTokenRevoked =
      error instanceof HubSpotApiError &&
      error.status === 400 &&
      (!error.apiCode || ["invalid_grant", "BAD_REFRESH_TOKEN"].includes(error.apiCode));

    if (refreshTokenRevoked) {
      await prisma.hubSpotConnection.update({
        where: { id: connectionId },
        data: { syncStatus: "AUTH_REQUIRED" },
      });

      throw new AppError(
        401,
        "HubSpot authorization is no longer valid. Reconnect the account.",
        "HUBSPOT_AUTH_REQUIRED",
      );
    }

    throw error;
  }
}
