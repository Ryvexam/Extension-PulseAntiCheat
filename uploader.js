// ============================================================
// Pulse Hesias — Upload Queue
// Retry automatique jusqu'à 10 tentatives
// ============================================================

// PULSE_BACKEND_URL / PULSE_API_TOKEN are injected at build time
// (see scripts/build-extension.js). The extension sends with no per-install
// setup; chrome.storage values still override them if present.
const DEFAULT_API_BASE_URL =
  (typeof PULSE_BACKEND_URL !== "undefined" && PULSE_BACKEND_URL) || "http://localhost:3000";
const DEFAULT_API_TOKEN =
  (typeof PULSE_API_TOKEN !== "undefined" && PULSE_API_TOKEN) || "";
const MAX_RETRIES = 10;
let dernierUploadScreenshot = null;
let dernierStatutUpload = "idle";

// ─── WebSocket transport (lazy + fallback HTTP) ───────────────
let wsConnection = null;
let wsReconnectDelay = 1000;
let wsReconnectTimer = null;
const WS_MAX_DELAY = 30000;

function wsUrlFromBase(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/audit";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

async function ensureWs() {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) return wsConnection;
  if (wsConnection && wsConnection.readyState === WebSocket.CONNECTING) return null;
  const api = await getApiConfig();
  try {
    const ws = new WebSocket(wsUrlFromBase(api.baseUrl, api.token));
    wsConnection = ws;
    ws.addEventListener("open", () => { wsReconnectDelay = 1000; });
    ws.addEventListener("close", () => {
      wsConnection = null;
      if (wsReconnectTimer) return;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        wsReconnectDelay = Math.min(WS_MAX_DELAY, wsReconnectDelay * 2);
        ensureWs();
      }, wsReconnectDelay);
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch {} });
  } catch {
    return null;
  }
  return null;
}

function envoyerWs(kind, payload) {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return false;
  try {
    wsConnection.send(JSON.stringify({ kind, payload }));
    return true;
  } catch {
    return false;
  }
}

async function getApiConfig() {
  const config = await chrome.storage.local.get({
    apiBaseUrl: DEFAULT_API_BASE_URL,
    apiToken: ""
  });

  return {
    baseUrl: String(config.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    token: String(config.apiToken || DEFAULT_API_TOKEN)
  };
}

function buildAuthHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let extensionIdentityPromise = null;
async function getExtensionIdentity() {
  if (!extensionIdentityPromise) {
    extensionIdentityPromise = new Promise((resolve) => {
      try {
        chrome.management.getSelf((info) => {
          if (chrome.runtime.lastError) {
            resolve({
              extensionId: chrome.runtime.id,
              extensionInstallType: "unknown",
              extensionVersion: chrome.runtime.getManifest().version
            });
            return;
          }
          resolve({
            extensionId: info?.id || chrome.runtime.id,
            extensionInstallType: String(info?.installType || "unknown").toLowerCase(),
            extensionVersion: info?.version || chrome.runtime.getManifest().version
          });
        });
      } catch {
        resolve({
          extensionId: chrome.runtime.id,
          extensionInstallType: "unknown",
          extensionVersion: chrome.runtime.getManifest().version
        });
      }
    });
  }
  return extensionIdentityPromise;
}

async function withExtensionIdentity(payload = {}) {
  const identity = await getExtensionIdentity();
  return { ...payload, ...identity };
}

async function parseJsonResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ─── Upload screenshot ────────────────────────────────────────

async function uploadScreenshot(record) {
  if (record.retries >= MAX_RETRIES) {
    console.warn(`[Pulse Hesias] Screenshot ${record.id} : max retries atteint, abandon`);
    await majStatutScreenshot(record.id, "failed");
    return;
  }

  try {
    const formData = new FormData();
    formData.append("screenshot", record.blob, `screenshot_${record.timestamp}.jpg`);
    formData.append("examId", record.examId);
    formData.append("studentId", record.studentId);
    formData.append("timestamp", record.timestamp);
    formData.append("kind", record.kind || "screenshot");
    if (record.eventType) formData.append("eventType", record.eventType);
    if (record.eventTimestamp) formData.append("eventTimestamp", record.eventTimestamp);
    if (Number.isFinite(record.relativeMs)) formData.append("relativeMs", record.relativeMs);
    if (record.tabId) formData.append("tabId", record.tabId);
    if (Number.isFinite(record.tabIndex)) formData.append("tabIndex", record.tabIndex);
    if (record.tabUrl) formData.append("tabUrl", record.tabUrl);
    if (record.tabTitle) formData.append("tabTitle", record.tabTitle);
    if (typeof record.tabActive === "boolean") formData.append("tabActive", String(record.tabActive));
    if (Number.isFinite(record.windowId)) formData.append("windowId", record.windowId);

    const identity = await getExtensionIdentity();
    formData.append("extensionId", identity.extensionId);
    formData.append("extensionInstallType", identity.extensionInstallType);
    formData.append("extensionVersion", identity.extensionVersion);

    const api = await getApiConfig();
    const response = await fetch(`${api.baseUrl}/api/exam/screenshots`, {
      method: "POST",
      headers: buildAuthHeaders(api.token),
      body: formData
    });

    if (response.ok) {
      await majStatutScreenshot(record.id, "uploaded");
      dernierUploadScreenshot = Number(record.timestamp) || Date.now();
      dernierStatutUpload = "uploaded";
      console.log(`[Pulse Hesias] Screenshot ${record.id} uploadé`);
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    dernierStatutUpload = "failed";
    console.warn(`[Pulse Hesias] Upload échoué (tentative ${record.retries + 1}):`, err.message);
    await majStatutScreenshot(record.id, "pending"); // remet en queue
  }
}

// ─── Upload infraction ────────────────────────────────────────

async function uploadInfraction(infraction) {
  ensureWs();
  const payload = await withExtensionIdentity(infraction);
  if (envoyerWs("infraction", payload)) return { ok: true, transport: "ws" };
  try {
    const api = await getApiConfig();
    const response = await fetch(`${api.baseUrl}/api/exam/infractions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(api.token) },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const details = await parseJsonResponse(response);
      return {
        ok: false,
        status: response.status,
        official: response.status !== 403,
        reason: details?.reason || details?.error || null,
        extension: details?.extension || null
      };
    }
    return { ok: true, transport: "http" };
  } catch (err) {
    console.warn("[Pulse Hesias] Infraction non envoyée:", err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Upload heartbeat ─────────────────────────────────────────

async function uploadHeartbeat(heartbeat) {
  ensureWs();
  const payload = await withExtensionIdentity({
    ...heartbeat,
    lastScreenshotTimestamp: dernierUploadScreenshot,
    lastUploadStatus: dernierStatutUpload
  });
  if (envoyerWs("heartbeat", payload)) { dernierStatutUpload = "heartbeat_ws"; return { ok: true, transport: "ws" }; }
  try {
    const api = await getApiConfig();
    const response = await fetch(`${api.baseUrl}/api/exam/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(api.token) },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      dernierStatutUpload = `heartbeat_http_${response.status}`;
      const details = await parseJsonResponse(response);
      return {
        ok: false,
        status: response.status,
        official: response.status !== 403,
        reason: details?.reason || details?.error || null,
        extension: details?.extension || null
      };
    }
    dernierStatutUpload = "heartbeat_ok";
    return { ok: true, transport: "http" };
  } catch (err) {
    dernierStatutUpload = "heartbeat_failed";
    console.warn("[Pulse Hesias] Heartbeat non envoyé:", err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Drain queue ──────────────────────────────────────────────

async function drainerQueue() {
  try {
    const pending = await getScreenshotsPending();
    if (pending.length === 0) return;

    console.log(`[Pulse Hesias] Queue: ${pending.length} screenshots en attente`);

    // Upload séquentiel pour ne pas saturer
    for (const record of pending) {
      await uploadScreenshot(record);
    }

    // Nettoyer les uploadés
    await supprimerScreenshotsUploades();
  } catch (err) {
    console.error("[Pulse Hesias] Erreur drain queue:", err);
  }
}
