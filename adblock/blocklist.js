const BLOCKED_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "adservice.google.co.uk",
  "ads.yahoo.com",
  "adnxs.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "zedo.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "moatads.com",
  "adsrvr.org",
  "tracker.example.com",
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "facebook.net",
  "connect.facebook.net",
  "pixel.facebook.com"
];

const BLOCKED_DOMAIN_SET = new Set(BLOCKED_DOMAINS);

module.exports = {
  BLOCKED_DOMAINS,
  BLOCKED_DOMAIN_SET
};
