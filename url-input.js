"use strict";

const DEFAULT_SEARCH_URL = "https://duckduckgo.com/?q=";

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const URI_SCHEME_WITH_AUTHORITY_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const HOST_PORT_RE = /^(?<host>\[[^\]\s]+\]|[^:/?#\s]+):(?<port>\d+)(?<suffix>[/?#].*)?$/;
const HOST_RE = /^(?<host>\[[^\]\s]+\]|[^:/?#\s]+)(?<suffix>[/?#].*)?$/;

function parseIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;

  const octets = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    octets.push(octet);
  }

  return octets;
}

function isHostnameWithDot(host) {
  if (!host.includes(".") || host.length > 253) return false;
  const labels = host.split(".");

  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/i.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }

  return true;
}

function isBracketedIpv6(host) {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const inner = host.slice(1, -1);
  if (!inner || !inner.includes(":")) return false;
  return /^[0-9a-f:.%]+$/i.test(inner);
}

function parseHostInfo(host) {
  const lowerHost = host.toLowerCase();
  if (lowerHost === "localhost") {
    return { type: "localhost" };
  }

  const ipv4Octets = parseIpv4(lowerHost);
  if (ipv4Octets) {
    return { type: "ipv4", octets: ipv4Octets };
  }

  if (isBracketedIpv6(host)) {
    return { type: "ipv6", value: host.slice(1, -1).toLowerCase() };
  }

  if (isHostnameWithDot(lowerHost)) {
    return { type: "hostname" };
  }

  return null;
}

function parseHostPortShorthand(value) {
  if (value.includes(" ")) return null;

  const match = HOST_PORT_RE.exec(value);
  if (!match?.groups?.host) return null;

  const hostInfo = parseHostInfo(match.groups.host);
  if (!hostInfo) return null;

  return hostInfo;
}

function parseHostTarget(value) {
  if (value.includes(" ")) return null;

  const match = HOST_RE.exec(value);
  if (!match?.groups?.host) return null;

  return parseHostInfo(match.groups.host);
}

function isLocalIpv4(octets) {
  const [a, b] = octets;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;

  return false;
}

function isLocalIpv6(value) {
  const normalized = value.split("%")[0].toLowerCase();

  if (normalized === "::" || normalized === "::1") return true;

  const firstSegment = normalized.split(":").find((segment) => segment.length > 0) || "0";
  const firstValue = Number.parseInt(firstSegment, 16);
  if (Number.isNaN(firstValue)) return false;

  if ((firstValue & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((firstValue & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local

  return false;
}

function isLocalHostInfo(hostInfo) {
  if (!hostInfo) return false;
  if (hostInfo.type === "localhost") return true;
  if (hostInfo.type === "ipv4") return isLocalIpv4(hostInfo.octets);
  if (hostInfo.type === "ipv6") return isLocalIpv6(hostInfo.value);
  return false;
}

function isExplicitUri(value) {
  return URI_SCHEME_WITH_AUTHORITY_RE.test(value) || URI_SCHEME_RE.test(value);
}

function looksLikeDomainTarget(value) {
  const hostInfo = parseHostTarget(value);
  if (!hostInfo) return false;
  return hostInfo.type !== "localhost";
}

function normalizeInput(raw, options = {}) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const searchUrl = options.searchUrl || DEFAULT_SEARCH_URL;
  const shorthandHost = parseHostPortShorthand(value);
  if (shorthandHost) {
    const scheme = isLocalHostInfo(shorthandHost) ? "http://" : "https://";
    return `${scheme}${value}`;
  }

  if (isExplicitUri(value)) {
    return value;
  }

  const hostInfo = parseHostTarget(value);
  if (isLocalHostInfo(hostInfo)) {
    return `http://${value}`;
  }

  if (looksLikeDomainTarget(value)) {
    return `https://${value}`;
  }

  return `${searchUrl}${encodeURIComponent(value)}`;
}

module.exports = {
  normalizeInput
};
