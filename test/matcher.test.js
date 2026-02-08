const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractHostname,
  isSubdomainOrSame,
  isSameSite,
  isBlockedHost
} = require("../adblock/matcher");

test("extractHostname returns normalized host for valid urls", () => {
  assert.equal(extractHostname("https://Sub.Example.com/path"), "sub.example.com");
});

test("extractHostname safely returns null for invalid input", () => {
  assert.equal(extractHostname("not a valid url"), null);
  assert.equal(extractHostname("null"), null);
  assert.equal(extractHostname(undefined), null);
});

test("isSubdomainOrSame returns true for same host and subdomains", () => {
  assert.equal(isSubdomainOrSame("a.b.example.com", "example.com"), true);
  assert.equal(isSubdomainOrSame("example.com", "example.com"), true);
});

test("isSubdomainOrSame returns false for unrelated hosts", () => {
  assert.equal(isSubdomainOrSame("example.com", "tracker.com"), false);
});

test("isSameSite detects site relation in either direction", () => {
  assert.equal(isSameSite("cdn.example.com", "example.com"), true);
  assert.equal(isSameSite("example.com", "cdn.example.com"), true);
  assert.equal(isSameSite("example.com", "analytics.vendor.com"), false);
});

test("isBlockedHost blocks exact matches and subdomains", () => {
  assert.equal(isBlockedHost("doubleclick.net"), true);
  assert.equal(isBlockedHost("stats.g.doubleclick.net"), true);
});

test("isBlockedHost allows hosts not in blocklist", () => {
  assert.equal(isBlockedHost("example.com"), false);
  assert.equal(isBlockedHost("cdn.example.org"), false);
});
