import { AppError } from "./errors.js";

export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
] as const;

const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_API_URL = "https://api.hubapi.com";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new AppError(500,`Required environment variable ${name} is missing`,"CONFIGURATION_ERROR");
  }

  return value;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new AppError(
      500,
      `Environment variable ${name} must be a valid URL`,
      "CONFIGURATION_ERROR",
    );
  }
}

export function getHubSpotOAuthConfig() {
  const clientId = requiredEnv("HUBSPOT_CLIENT_ID");
  const clientSecret = requiredEnv("HUBSPOT_CLIENT_SECRET");
  const redirectUri = requiredEnv("HUBSPOT_REDIRECT_URI");
  const frontendUrl = requiredEnv("FRONTEND_URL");

  const redirectUrl = parseUrl(redirectUri, "HUBSPOT_REDIRECT_URI");
  if (!['http:', 'https:'].includes(redirectUrl.protocol)) {
    throw new AppError(500,"HUBSPOT_REDIRECT_URI must use http or https","CONFIGURATION_ERROR");
  }

  if (
    redirectUrl.pathname !== "/auth/hubspot/callback" ||
    (redirectUrl.protocol === "http:" &&
      !["localhost", "127.0.0.1", "::1"].includes(redirectUrl.hostname))
  ) {
    throw new AppError(
      500,
      "HUBSPOT_REDIRECT_URI must point to /auth/hubspot/callback and use HTTPS outside localhost",
      "CONFIGURATION_ERROR",
    );
  }

  const frontend = parseUrl(frontendUrl, "FRONTEND_URL");
  if (!['http:', 'https:'].includes(frontend.protocol)) {
    throw new AppError(
      500,
      "FRONTEND_URL must use http or https",
      "CONFIGURATION_ERROR",
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    frontendUrl: frontend.toString(),
    scopes: HUBSPOT_SCOPES,
    authorizeUrl: HUBSPOT_AUTHORIZE_URL,
    apiBaseUrl: HUBSPOT_API_URL,
  };
}

export function getHubSpotApiConfig() {
  const clientId = requiredEnv("HUBSPOT_CLIENT_ID");
  const clientSecret = requiredEnv("HUBSPOT_CLIENT_SECRET");

  return {
    clientId,
    clientSecret,
    apiBaseUrl: HUBSPOT_API_URL,
  };
}

export function isHubSpotNotesSyncEnabled(): boolean {
  return process.env.HUBSPOT_NOTES_SYNC_ENABLED?.trim().toLowerCase() === "true";
}

export function buildFrontendRedirect(
  result: "success" | "error",
  reason?: string,
): string {
  const { frontendUrl } = getHubSpotOAuthConfig();
  const redirect = new URL(frontendUrl);
  redirect.searchParams.set("hubspot", result);

  if (reason) {
    redirect.searchParams.set("reason", reason);
  }

  return redirect.toString();
}
