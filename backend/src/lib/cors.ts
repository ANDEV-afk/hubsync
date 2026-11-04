const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;
const LOOPBACK_HOST_SET = new Set<string>(LOOPBACK_HOSTS);

function originForHost(url: URL, hostname: (typeof LOOPBACK_HOSTS)[number]): string {
  const formattedHostname = hostname === "::1" ? `[${hostname}]` : hostname;
  return new URL(
    `${url.protocol}//${formattedHostname}${url.port ? `:${url.port}` : ""}`,
  ).origin;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
    return (
      (protocol === "http:" || protocol === "https:") &&
      LOOPBACK_HOST_SET.has(normalizedHostname)
    );
  } catch {
    return false;
  }
}

export function getAllowedCorsOrigins(frontendUrl: string | undefined): Set<string> {
  if (!frontendUrl?.trim()) {
    return new Set();
  }

  const configuredUrl = new URL(frontendUrl.trim());
  const origins = new Set([configuredUrl.origin]);

  if (LOOPBACK_HOSTS.includes(configuredUrl.hostname as (typeof LOOPBACK_HOSTS)[number])) {
    for (const hostname of LOOPBACK_HOSTS) {
      origins.add(originForHost(configuredUrl, hostname));
    }
  }

  return origins;
}

export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: Set<string>,
): boolean {
  if (!origin) {
    return true;
  }

  return allowedOrigins.has(origin) || isLoopbackOrigin(origin);
}
