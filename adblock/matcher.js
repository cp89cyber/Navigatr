const { BLOCKED_DOMAIN_SET } = require("./blocklist");

function normalizeHost(host) {
  if (typeof host !== "string") return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

function extractHostname(urlOrOrigin) {
  if (typeof urlOrOrigin !== "string") return null;
  const value = urlOrOrigin.trim();
  if (!value || value === "null") return null;

  try {
    return normalizeHost(new URL(value).hostname);
  } catch (_err) {
    try {
      return normalizeHost(new URL(`http://${value}`).hostname);
    } catch (_err2) {
      return null;
    }
  }
}

function isSubdomainOrSame(host, candidate) {
  const normalizedHost = normalizeHost(host);
  const normalizedCandidate = normalizeHost(candidate);
  if (!normalizedHost || !normalizedCandidate) return false;
  return (
    normalizedHost === normalizedCandidate ||
    normalizedHost.endsWith(`.${normalizedCandidate}`)
  );
}

function isSameSite(hostA, hostB) {
  return isSubdomainOrSame(hostA, hostB) || isSubdomainOrSame(hostB, hostA);
}

function isBlockedHost(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;

  for (const blockedDomain of BLOCKED_DOMAIN_SET) {
    if (isSubdomainOrSame(normalizedHost, blockedDomain)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  extractHostname,
  isSubdomainOrSame,
  isSameSite,
  isBlockedHost
};
