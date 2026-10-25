import { AppError } from "./errors.js";

export interface HubSpotTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  hub_id?: unknown;
}

export interface HubSpotContactRecord {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotContactsPage {
  results: HubSpotContactRecord[];
  paging?: {
    next?: {
      after?: string;
    };
  };
}

export interface HubSpotNoteCreateResponse {
  id?: unknown;
}

export interface HubSpotRequestOptions {
  retryNetworkErrors?: boolean;
}

export class HubSpotApiError extends Error {
  public readonly status: number;
  public readonly apiCode: string | undefined;
  public readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    apiCode?: string,
    retryAfterMs?: number,
  ) {
    super("HubSpot API request failed");
    this.name = "HubSpotApiError";
    this.status = status;
    this.apiCode = apiCode;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRYABLE_STATUSES = new Set([
  423, 429, 477, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526,
]);

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}

function extractApiCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const value = record.error ?? record.code ?? record.category;
  return typeof value === "string" ? value.slice(0, 80) : undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function hubspotRequest<T>(
  input: string | URL,
  init: RequestInit,
  maxAttempts = 4,
  options: HubSpotRequestOptions = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      const payload = await readResponseBody(response);

      if (response.ok) {
        return payload as T;
      }

      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      const apiError = new HubSpotApiError(
        response.status,
        extractApiCode(payload),
        retryAfterMs,
      );

      if (
        !RETRYABLE_STATUSES.has(response.status) ||
        attempt === maxAttempts
      ) {
        throw apiError;
      }

      await wait(Math.min(retryAfterMs ?? 2 ** attempt * 500, 30_000));
    } catch (error) {
      if (error instanceof HubSpotApiError) {
        if (
          !RETRYABLE_STATUSES.has(error.status) ||
          attempt === maxAttempts
        ) {
          throw error;
        }

        await wait(Math.min(error.retryAfterMs ?? 2 ** attempt * 500, 30_000));
        continue;
      }

      if (attempt === maxAttempts) {
        throw new HubSpotApiError(503, "NETWORK_ERROR");
      }

      if (options.retryNetworkErrors === false) {
        throw new HubSpotApiError(503, "AMBIGUOUS_NETWORK_ERROR");
      }

      await wait(Math.min(2 ** attempt * 500, 30_000));
    }
  }

  throw new AppError(502, "HubSpot request failed", "HUBSPOT_REQUEST_FAILED");
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export async function exchangeAuthorizationCode(
  apiBaseUrl: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<HubSpotTokenResponse> {
  return hubspotRequest<HubSpotTokenResponse>(
    `${apiBaseUrl}/oauth/v3/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    },
  );
}

export async function refreshHubSpotAccessToken(
  apiBaseUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<HubSpotTokenResponse> {
  return hubspotRequest<HubSpotTokenResponse>(
    `${apiBaseUrl}/oauth/v3/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    },
  );
}

export async function introspectHubSpotAccessToken(
  apiBaseUrl: string,
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<{ hub_id?: unknown }> {
  return hubspotRequest<{ hub_id?: unknown }>(
    `${apiBaseUrl}/oauth/v3/token/introspect`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: clientId,
        client_secret: clientSecret,
        token_type_hint: "access_token",
        access_token: accessToken,
      }),
    },
  );
}

export function parseContactsPage(payload: unknown): HubSpotContactsPage {
  if (!payload || typeof payload !== "object") {
    throw new AppError(
      502,
      "HubSpot returned an invalid contacts response",
      "HUBSPOT_INVALID_RESPONSE",
    );
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new AppError(
      502,
      "HubSpot returned an invalid contacts response",
      "HUBSPOT_INVALID_RESPONSE",
    );
  }

  const results: HubSpotContactRecord[] = [];
  for (const item of record.results) {
    if (!item || typeof item !== "object") {
      throw new AppError(
        502,
        "HubSpot returned an invalid contact record",
        "HUBSPOT_INVALID_RESPONSE",
      );
    }

    const contact = item as Record<string, unknown>;
    if (typeof contact.id !== "string" || !contact.id) {
      throw new AppError(
        502,
        "HubSpot returned a contact without an ID",
        "HUBSPOT_INVALID_RESPONSE",
      );
    }

    const properties =
      contact.properties && typeof contact.properties === "object"
        ? (contact.properties as Record<string, string | null>)
        : {};

    results.push({ id: contact.id, properties });
  }

  const paging = record.paging;
  const next =
    paging && typeof paging === "object"
      ? (paging as Record<string, unknown>).next
      : undefined;
  const after =
    next && typeof next === "object"
      ? (next as Record<string, unknown>).after
      : undefined;

  return {
    results,
    ...(typeof after === "string" && after
      ? { paging: { next: { after } } }
      : {}),
  };
}

export async function fetchHubSpotContacts(
  apiBaseUrl: string,
  accessToken: string,
  after?: string,
): Promise<HubSpotContactsPage> {
  const url = new URL(`${apiBaseUrl}/crm/v3/objects/contacts`);
  url.searchParams.set("limit", "100");
  url.searchParams.set(
    "properties",
    ["email", "firstname", "lastname", "createdate", "lastmodifieddate"].join(
      ",",
    ),
  );

  if (after) {
    url.searchParams.set("after", after);
  }

  const payload = await hubspotRequest<unknown>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });

  return parseContactsPage(payload);
}

export async function createHubSpotNote(
  apiBaseUrl: string,
  accessToken: string,
  contactId: string,
  body: string,
  createdAt: Date,
): Promise<string> {
  const payload = await hubspotRequest<HubSpotNoteCreateResponse>(
    `${apiBaseUrl}/crm/v3/objects/notes`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          hs_timestamp: createdAt.toISOString(),
          hs_note_body: body,
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 202,
              },
            ],
          },
        ],
      }),
    },
    4,
    { retryNetworkErrors: false },
  );

  if (typeof payload.id !== "string" || !payload.id) {
    throw new AppError(
      502,
      "HubSpot returned an invalid note response",
      "HUBSPOT_INVALID_RESPONSE",
    );
  }

  return payload.id;
}
