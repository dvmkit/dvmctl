import { DvmError } from "@dvmkit/sdk/internal";

export function validateAdminMountPrefix(prefix: string | undefined): string {
  if (prefix === undefined) return "";
  const segments = prefix.split("/").slice(1);
  if (
    !prefix.startsWith("/") || segments.length === 0 ||
    segments.some((segment) => !/^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/.test(segment)) ||
    new URL(prefix, "https://mount.example").pathname !== prefix
  ) {
    throw new DvmError(
      "invalid_mount_prefix",
      "Mount prefix must be a leading-slash path with no trailing slash or dot segments.",
      "Use --mount-prefix /feed, or omit the option for a root mount. URLs, query strings, and fragments are not prefixes."
    );
  }
  return prefix;
}

/** Append an explicit mount to an endpoint that may already include a base path. */
export function adminEndpoint(endpoint: string, mountPrefix?: string): string {
  const prefix = validateAdminMountPrefix(mountPrefix);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DvmError("invalid_admin_endpoint", "DVM admin endpoint must be an absolute HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash
  ) {
    throw new DvmError("invalid_admin_endpoint", "DVM admin endpoint must be an HTTP or HTTPS URL without credentials, a query string, or a fragment.");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath) validateAdminMountPrefix(basePath);
  return `${url.origin}${basePath}${prefix}`;
}
