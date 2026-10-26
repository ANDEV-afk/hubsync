const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

function originForHost(url: URL, hostname: (typeof LOOPBACK_HOSTS)[number]): string {
  const formattedHostname = hostname === "::1" ? `[${hostname}]` : hostname;
  return new URL(
    `${url.protocol}//${formattedHostname}${url.port ? `:${url.port}` : ""}`,
  ).origin;
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
