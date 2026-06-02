// ============================================================
// Pulse Hesias — URL allow-list matching
// Shared by the service worker. Converts Chrome match patterns
// (e.g. "https://*.hesias.fr/*") into RegExp and tests URLs.
// Works as a plain bundled script (defines globals) and as a
// CommonJS module (for unit tests).
// ============================================================

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "https://*.hesias.fr/*" → /^https:\/\/(?:[^/.]+\.)*hesias\.fr\/.*$/
function matchPatternToRegExp(pattern) {
  const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/.exec(String(pattern || ""));
  if (!match) return null;

  const scheme = match[1] === "*" ? "https?" : match[1];
  const host = match[2];
  const path = match[3] || "/*";

  let hostRe;
  if (host === "*") {
    hostRe = "[^/]+";
  } else if (host.startsWith("*.")) {
    hostRe = "(?:[^/.]+\\.)*" + escapeRegExp(host.slice(2));
  } else {
    hostRe = escapeRegExp(host);
  }

  const pathRe = escapeRegExp(path).replace(/\\\*/g, ".*");
  return new RegExp("^" + scheme + ":\\/\\/" + hostRe + pathRe + "$");
}

function isAllowedUrl(url, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    const re = matchPatternToRegExp(pattern);
    return re ? re.test(String(url || "")) : false;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { matchPatternToRegExp, isAllowedUrl, escapeRegExp };
}
