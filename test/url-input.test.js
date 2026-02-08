const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeInput } = require("../url-input");

const SEARCH_URL = "https://duckduckgo.com/?q=";

function normalize(raw) {
  return normalizeInput(raw, { searchUrl: SEARCH_URL });
}

test("normalizeInput returns null for empty input", () => {
  assert.equal(normalize(""), null);
});

test("normalizeInput prefixes https for bare domain", () => {
  assert.equal(normalize("example.com"), "https://example.com");
});

test("normalizeInput prefixes https for non-local host:port shorthand", () => {
  assert.equal(normalize("example.com:8080"), "https://example.com:8080");
});

test("normalizeInput preserves path/query/hash for non-local host:port shorthand", () => {
  assert.equal(
    normalize("example.com:8080/path?q=1#x"),
    "https://example.com:8080/path?q=1#x"
  );
});

test("normalizeInput prefixes http for localhost host:port shorthand", () => {
  assert.equal(normalize("localhost:3000"), "http://localhost:3000");
});

test("normalizeInput prefixes http for loopback IPv4 host:port shorthand", () => {
  assert.equal(normalize("127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("normalizeInput prefixes http for private IPv4 host:port shorthand", () => {
  assert.equal(normalize("10.0.0.5:3000"), "http://10.0.0.5:3000");
});

test("normalizeInput prefixes http for bracketed loopback IPv6 host:port shorthand", () => {
  assert.equal(normalize("[::1]:5173"), "http://[::1]:5173");
});

test("normalizeInput preserves explicit http URIs", () => {
  assert.equal(normalize("http://example.com"), "http://example.com");
});

test("normalizeInput preserves explicit opaque URIs", () => {
  assert.equal(normalize("mailto:test@example.com"), "mailto:test@example.com");
  assert.equal(normalize("foo:bar"), "foo:bar");
});

test("normalizeInput builds search URL for plain search terms", () => {
  assert.equal(
    normalize("some search terms"),
    "https://duckduckgo.com/?q=some%20search%20terms"
  );
});
