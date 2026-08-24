const PUBLIC_LANDING_HOSTS = new Set(["touchmyapi.com", "www.touchmyapi.com"]);

export function isPublicLandingHost(hostname: string): boolean {
  return PUBLIC_LANDING_HOSTS.has(hostname.trim().toLowerCase().replace(/\.$/u, ""));
}
