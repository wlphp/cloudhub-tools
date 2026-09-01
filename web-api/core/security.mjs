const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:1420",
  "http://localhost:1420",
];

function normalizedOrigin(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!text || text === "*") return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function allowedWebOrigins(value = process.env.CLOUDHUB_TOOLS_WEB_ALLOWED_ORIGINS) {
  const configured = String(value || "")
    .split(",")
    .map(normalizedOrigin)
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

export function webRequestOriginPolicy(req, allowedOrigins = allowedWebOrigins()) {
  const origin = normalizedOrigin(req.headers?.origin);
  const fetchSite = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (!origin) {
    return {
      allowed: fetchSite !== "cross-site",
      origin: null,
      reason: fetchSite === "cross-site" ? "cross-site" : "non-browser",
    };
  }
  return {
    allowed: allowedOrigins.has(origin),
    origin,
    reason: allowedOrigins.has(origin) ? "allowed-origin" : "forbidden-origin",
  };
}

export function applyWebCors(req, res, allowedOrigins = allowedWebOrigins()) {
  const policy = webRequestOriginPolicy(req, allowedOrigins);
  res.setHeader("Vary", "Origin");
  if (policy.allowed && policy.origin) {
    res.setHeader("Access-Control-Allow-Origin", policy.origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return policy;
}
