import { Router } from "express";
import { buildFrontendRedirect } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import {
  consumeOAuthState,
  issueOAuthState,
} from "../lib/oauthState.js";
import {
  connectHubSpotWithAuthorizationCode,
  createHubSpotAuthorizationUrl,
} from "../services/hubspotOAuth.js";
import { enqueueContactSync } from "../services/syncJobs.js";

const router = Router();

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeOAuthReason(error: unknown): string {
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") {
    return "configuration_error";
  }

  return "oauth_failed";
}

router.get("/hubspot", (_request, response) => {
  const state = issueOAuthState();
  response.redirect(302, createHubSpotAuthorizationUrl(state));
});

router.get("/hubspot/callback", async (request, response, next) => {
  const state = queryString(request.query.state);

  try {
    if (!state || !consumeOAuthState(state)) {
      throw new AppError(
        400,
        "OAuth state is invalid or expired",
        "INVALID_OAUTH_STATE",
      );
    }

    const providerError = queryString(request.query.error);
    if (providerError) {
      throw new AppError(
        400,
        "HubSpot did not approve the connection",
        "HUBSPOT_OAUTH_DENIED",
      );
    }

    const code = queryString(request.query.code);
    if (!code) {
      throw new AppError(
        400,
        "HubSpot did not return an authorization code",
        "HUBSPOT_CODE_MISSING",
      );
    }

    const connection = await connectHubSpotWithAuthorizationCode(code);

    await enqueueContactSync(connection.id);

    response.redirect(302, buildFrontendRedirect("success"));
  } catch (error) {
    try {
      response.redirect(302, buildFrontendRedirect("error", safeOAuthReason(error)));
    } catch (redirectError) {
      next(redirectError);
    }
  }
});

router.get("/hubspot/status", async (request, response, next) => {
  try {
    const { default: prisma } = await import("../lib/prisma.js");
    const connections = await prisma.hubSpotConnection.findMany({
      select: {
        hubspotPortalId: true,
        syncStatus: true,
        lastSyncAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (connections.length === 0) {
      response.json({
        success: true,
        data: {
          connected: false,
          connectionCount: 0,
        },
      });
      return;
    }

    if (connections.length > 1) {
      response.status(409).json({
        success: false,
        error: {
          code: "MULTIPLE_CONNECTIONS",
          message: "Multiple connections exist; user authentication is required.",
        },
        data: { connected: true, connectionCount: connections.length },
      });
      return;
    }

    const connection = connections[0];
    response.json({
      success: true,
      data: {
        connected: true,
        connectionCount: 1,
        portalId: connection?.hubspotPortalId,
        syncStatus: connection?.syncStatus,
        lastSyncAt: connection?.lastSyncAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
