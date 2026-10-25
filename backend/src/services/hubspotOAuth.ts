import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import {
  exchangeAuthorizationCode,
  introspectHubSpotAccessToken,
} from "../lib/hubspotApi.js";
import { getHubSpotOAuthConfig } from "../lib/config.js";
import { encryptToken } from "../lib/crypto.js";

function parsePositiveInteger(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }

  return undefined;
}

function parseExpiresAt(expiresIn: unknown): Date {
  const seconds =
    typeof expiresIn === "number"? expiresIn: typeof expiresIn === "string"? Number(expiresIn) : Number.NaN;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AppError(
      502,
      "HubSpot returned an invalid token expiration",
      "HUBSPOT_INVALID_TOKEN_RESPONSE",
    );
  }

  return new Date(Date.now() + seconds * 1000);
}

export function createHubSpotAuthorizationUrl(state: string): string {
  const config = getHubSpotOAuthConfig();
  const authorizationUrl = new URL(config.authorizeUrl);
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("state", state);
  return authorizationUrl.toString();
}

export async function connectHubSpotWithAuthorizationCode(code: string) {
  const config = getHubSpotOAuthConfig();
  const tokenResponse = await exchangeAuthorizationCode(
    config.apiBaseUrl,
    config.clientId,
    config.clientSecret,
    config.redirectUri,
    code,
  );

  const accessToken = typeof tokenResponse.access_token === "string"? tokenResponse.access_token: undefined;
  const refreshToken =typeof tokenResponse.refresh_token === "string"? tokenResponse.refresh_token: undefined;

  if (!accessToken || !refreshToken) {
    throw new AppError(502,"HubSpot did not return the required OAuth tokens","HUBSPOT_INVALID_TOKEN_RESPONSE");
  }

  let portalId = parsePositiveInteger(tokenResponse.hub_id);
  if (!portalId) {
    const introspection = await introspectHubSpotAccessToken(
      config.apiBaseUrl,
      config.clientId,
      config.clientSecret,
      accessToken,
    );
    portalId = parsePositiveInteger(introspection.hub_id);
  }

  if (!portalId) {
    throw new AppError(502,"HubSpot did not return a valid account ID","HUBSPOT_ACCOUNT_ID_MISSING");
  }

  const connection = await prisma.hubSpotConnection.upsert({
    where: { hubspotPortalId: portalId },
    create: {
      hubspotPortalId: portalId,
      accessTokenEncrypted: encryptToken(accessToken),
      refreshTokenEncrypted: encryptToken(refreshToken),
      tokenExpiresAt: parseExpiresAt(tokenResponse.expires_in),
      syncCursor: null,
      lastSyncAt: null,
      syncStatus: "IDLE",
    },
    update: {
      accessTokenEncrypted: encryptToken(accessToken),
      refreshTokenEncrypted: encryptToken(refreshToken),
      tokenExpiresAt: parseExpiresAt(tokenResponse.expires_in),
      syncCursor: null,
      lastSyncAt: null,
      syncStatus: "IDLE",
    },
    select: {
      id: true,
      hubspotPortalId: true,
      syncStatus: true,
    },
  });

  return connection;
}
