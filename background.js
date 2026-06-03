// ============================================================
// Pulse Hesias v3 — Background Service Worker
// ============================================================

// In dev (unbuilt) these load as separate files. The build inlines them and
// strips this line (see scripts/build-extension.js).
importScripts("url-allow.js", "db.js", "uploader.js");

const PULSE_EXTENSION_ID = chrome.runtime.id;
const SCREENSHOT_INTERVAL_SECONDS = 30;
const HEARTBEAT_INTERVAL_SECONDS = 15;
const IDLE_THRESHOLD_SECONDS = 15;
const VM_SCORE_BLOCAGE = 60;
const EVIDENCE_CAPTURE_INTERVAL_MS = 1000;
const EVIDENCE_WINDOW_MS = 8000;
const EVIDENCE_JPEG_QUALITY = 35;
const REGLES_BLOCAGE_RESEAU = new Set([1, 11, 12, 13]);
const REGLES_BLOCAGE_IA = new Set(Array.from({ length: 27 }, (_, i) => i + 20));

const FOCUS_GRACE_MS = 1000;
const FOCUS_TIMEOUTS = new Map(); // windowId → timeoutId
const SESSIONS = new Map(); // tabId → { examId, studentId, startTime, windowId }
const PAGES_QCM = new Map(); // tabId → { examId, studentId, detectedAt }
const EVIDENCE_BUFFERS = new Map(); // tabId → [{ blob, timestamp }]
const EVIDENCE_TIMERS = new Map(); // tabId → intervalId

function getOngletsSurveilles() {
  return new Map([...PAGES_QCM.entries(), ...SESSIONS.entries()]);
}

// ─── Init ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Pulse Hesias v3] Installé");
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
  chrome.alarms.create("screenshot", { periodInMinutes: SCREENSHOT_INTERVAL_SECONDS / 60 });
  chrome.alarms.create("drainQueue", { periodInMinutes: 1 });
  chrome.alarms.create("heartbeat", { periodInMinutes: HEARTBEAT_INTERVAL_SECONDS / 60 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
  chrome.alarms.create("screenshot", { periodInMinutes: SCREENSHOT_INTERVAL_SECONDS / 60 });
  chrome.alarms.create("drainQueue", { periodInMinutes: 1 });
  chrome.alarms.create("heartbeat", { periodInMinutes: HEARTBEAT_INTERVAL_SECONDS / 60 });
});

// ─── Alarmes ───────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "screenshot") await prendreScreenshots();
  if (alarm.name === "drainQueue") await drainerQueue();
  if (alarm.name === "heartbeat") await envoyerHeartbeats();
});

// ─── Screenshots ───────────────────────────────────────────────
async function prendreScreenshots() {
  for (const [tabId, session] of SESSIONS.entries()) {
    try {
      const capture = await capturerOnglet(tabId, 50);
      if (!capture) continue;
      await sauvegarderScreenshot(capture.blob, session.examId, session.studentId, {
        kind: "periodic"
      });
    } catch (err) {
      console.error("[Pulse Hesias] Screenshot:", err);
    }
  }
}

async function envoyerHeartbeats(sessionActive = true) {
  for (const [tabId, session] of SESSIONS.entries()) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) continue;
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      const windows = await chrome.windows.getAll({ populate: false });
      await uploadHeartbeat({
        ...session,
        timestamp: Date.now(),
        extensionActive: true,
        sessionActive,
        fullscreen: !!tab.active,
        tabCount: tabs.length,
        windowCount: windows.length,
        currentUrl: tab.url || ""
      });
    } catch (err) {
      console.warn("[Pulse Hesias] Heartbeat:", err.message);
    }
  }
}

async function capturerOnglet(tabId, quality = EVIDENCE_JPEG_QUALITY) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;

  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) return resolve(null);
      resolve({ blob: dataUrlToBlob(dataUrl), timestamp: Date.now(), tab: decrireOnglet(tab) });
    });
  });
}

function decrireOnglet(tab) {
  if (!tab) return {};
  return {
    tabId: tab.id || null,
    tabIndex: Number.isFinite(tab.index) ? tab.index : null,
    tabUrl: tab.url || "",
    tabTitle: tab.title || "",
    tabActive: !!tab.active,
    windowId: Number.isFinite(tab.windowId) ? tab.windowId : null
  };
}

async function capturerTousOngletsFenetre(tabId, quality = EVIDENCE_JPEG_QUALITY) {
  const sourceTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!sourceTab) return [];

  const tabs = await chrome.tabs.query({ windowId: sourceTab.windowId });
  const originalActiveTab = tabs.find(tab => tab.active);
  const captures = [];

  for (const tab of tabs.sort((a, b) => a.index - b.index)) {
    if (!tab.id || tab.discarded) continue;

    try {
      await chrome.tabs.update(tab.id, { active: true });
      await attendre(120);

      const capture = await new Promise((resolve) => {
        chrome.tabs.captureVisibleTab(sourceTab.windowId, { format: "jpeg", quality }, (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) return resolve(null);
          resolve({ blob: dataUrlToBlob(dataUrl), timestamp: Date.now(), tab: decrireOnglet(tab) });
        });
      });

      if (capture) captures.push(capture);
    } catch (err) {
      console.warn("[Pulse Hesias] Capture onglet impossible:", err.message);
    }
  }

  if (originalActiveTab?.id) {
    await chrome.tabs.update(originalActiveTab.id, { active: true }).catch(() => {});
  }

  return captures;
}

function dataUrlToBlob(dataUrl) {
  const arr = dataUrl.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new Blob([u8arr], { type: mime });
}

function demarrerBufferEvidence(tabId) {
  if (EVIDENCE_TIMERS.has(tabId)) return;
  EVIDENCE_BUFFERS.set(tabId, []);

  const timerId = setInterval(async () => {
    const session = SESSIONS.get(tabId);
    if (!session) {
      arreterBufferEvidence(tabId);
      return;
    }

    const capture = await capturerOnglet(tabId);
    if (!capture) return;

    const buffer = EVIDENCE_BUFFERS.get(tabId) || [];
    buffer.push(capture);

    const cutoff = Date.now() - EVIDENCE_WINDOW_MS;
    while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
      buffer.shift();
    }

    EVIDENCE_BUFFERS.set(tabId, buffer);
  }, EVIDENCE_CAPTURE_INTERVAL_MS);

  EVIDENCE_TIMERS.set(tabId, timerId);
}

function arreterBufferEvidence(tabId) {
  const timerId = EVIDENCE_TIMERS.get(tabId);
  if (timerId) clearInterval(timerId);
  EVIDENCE_TIMERS.delete(tabId);
  EVIDENCE_BUFFERS.delete(tabId);
}

function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enregistrerEvidenceAutourEvenement(tabId, session, eventType, eventTimestamp = Date.now()) {
  if (!session) return;

  const before = (EVIDENCE_BUFFERS.get(tabId) || [])
    .filter(item => item.timestamp >= eventTimestamp - EVIDENCE_WINDOW_MS && item.timestamp <= eventTimestamp);

  for (const capture of before) {
    await sauvegarderScreenshot(capture.blob, session.examId, session.studentId, {
      kind: "evidence",
      timestamp: capture.timestamp,
      eventType,
      eventTimestamp,
      relativeMs: capture.timestamp - eventTimestamp,
      ...(capture.tab || {})
    });
  }

  const afterCount = Math.ceil(EVIDENCE_WINDOW_MS / EVIDENCE_CAPTURE_INTERVAL_MS);
  for (let i = 0; i < afterCount; i++) {
    await attendre(EVIDENCE_CAPTURE_INTERVAL_MS);
    const capture = await capturerOnglet(tabId);
    if (!capture) continue;
    await sauvegarderScreenshot(capture.blob, session.examId, session.studentId, {
      kind: "evidence",
      timestamp: capture.timestamp,
      eventType,
      eventTimestamp,
      relativeMs: capture.timestamp - eventTimestamp
    });
  }

  await drainerQueue();
}

// ─── Extensions tierces ────────────────────────────────────────
async function scannerExtensions() {
  const toutes = await chrome.management.getAll();
  const tierces = toutes.filter(e =>
    e.id !== PULSE_EXTENSION_ID && e.enabled && e.type === "extension"
  );
  if (tierces.length > 0) {
    for (const [tabId] of getOngletsSurveilles().entries()) {
      chrome.tabs.sendMessage(tabId, {
        type: "EXTENSION_DETECTED",
        extensions: tierces.map(e => ({ id: e.id, name: e.name }))
      }).catch(() => {});
    }
  }
  return tierces;
}

chrome.management.onEnabled.addListener(async (info) => {
  const onglets = getOngletsSurveilles();
  if (info.id === PULSE_EXTENSION_ID || onglets.size === 0) return;
  await sauvegarderInfraction("extension_activee", { id: info.id, name: info.name });
  for (const [tabId, session] of onglets.entries()) {
    const eventTimestamp = Date.now();
    chrome.tabs.sendMessage(tabId, {
      type: "EXTENSION_DETECTED",
      extensions: [{ id: info.id, name: info.name }]
    }).catch(() => {});
    await uploadInfraction({ type: "extension_activee", extensionName: info.name, ...session, timestamp: eventTimestamp });
    enregistrerEvidenceAutourEvenement(tabId, session, "extension_activee", eventTimestamp).catch(err => {
      console.warn("[Pulse Hesias] Evidence extension non enregistrée:", err.message);
    });
  }
});

chrome.management.onDisabled.addListener((info) => {
  const onglets = getOngletsSurveilles();
  if (info.id === PULSE_EXTENSION_ID || onglets.size === 0) return;
  // Vérifier si d'autres extensions sont encore actives
  scannerExtensions().then(restantes => {
    if (restantes.length === 0) {
      for (const [tabId] of getOngletsSurveilles().entries()) {
        chrome.tabs.sendMessage(tabId, { type: "EXTENSION_CLEARED" }).catch(() => {});
      }
    }
  });
});

// ─── Multi-écrans ──────────────────────────────────────────────
async function verifierEcrans() {
  const displays = await chrome.system.display.getInfo();
  if (displays.length > 1) {
    for (const [tabId, session] of SESSIONS.entries()) {
      const eventTimestamp = Date.now();
      chrome.tabs.sendMessage(tabId, { type: "MULTI_SCREEN_DETECTED", count: displays.length }).catch(() => {});
      await sauvegarderInfraction("multi_ecran", { count: displays.length });
      await uploadInfraction({ type: "multi_ecran", screenCount: displays.length, ...session, timestamp: eventTimestamp });
      enregistrerEvidenceAutourEvenement(tabId, session, "multi_ecran", eventTimestamp).catch(err => {
        console.warn("[Pulse Hesias] Evidence multi-écran non enregistrée:", err.message);
      });
    }
    return false;
  }
  return true;
}

// ─── Idle / réveil ─────────────────────────────────────────────
chrome.idle.onStateChanged.addListener(async (state) => {
  if (SESSIONS.size === 0) return;
  if (state === "active") {
    for (const [tabId] of SESSIONS.entries()) {
      chrome.tabs.sendMessage(tabId, { type: "FORCE_FULLSCREEN" }).catch(() => {});
    }
  } else if (state === "locked") {
    for (const [tabId, session] of SESSIONS.entries()) {
      const eventTimestamp = Date.now();
      await sauvegarderInfraction("ecran_verrouille", {});
      await uploadInfraction({ type: "ecran_verrouille", ...session, timestamp: eventTimestamp });
      enregistrerEvidenceAutourEvenement(tabId, session, "ecran_verrouille", eventTimestamp).catch(err => {
        console.warn("[Pulse Hesias] Evidence verrouillage non enregistrée:", err.message);
      });
    }
  }
});

// ─── Tab hijack ────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (SESSIONS.size === 0) return;
  const examTabIds = new Set(SESSIONS.keys());
  if (!examTabIds.has(tabId)) {
    const [firstExamTabId] = examTabIds;
    if (firstExamTabId) {
      chrome.tabs.update(firstExamTabId, { active: true });
      for (const [sessionTabId, session] of SESSIONS.entries()) {
        const eventTimestamp = Date.now();
        await uploadInfraction({ type: "changement_onglet", ...session, timestamp: eventTimestamp });
        enregistrerEvidenceAutourEvenement(sessionTabId, session, "changement_onglet", eventTimestamp).catch(err => {
          console.warn("[Pulse Hesias] Evidence changement onglet non enregistrée:", err.message);
        });
      }
    }
  }
});

// ─── Surveillance live ─────────────────────────────────────────

function trouverSessionParWindowId(windowId) {
  for (const [tabId, session] of SESSIONS.entries()) {
    if (session.windowId === windowId) return { tabId, session };
  }
  return null;
}

async function infractionEtUpload(tabId, session, type, details = {}) {
  const timestamp = Date.now();
  await sauvegarderInfraction(type, details);
  await uploadInfraction({ type, ...details, ...session, timestamp });
  enregistrerEvidenceAutourEvenement(tabId, session, type, timestamp).catch(err => {
    console.warn(`[Pulse Hesias] Evidence ${type} non enregistrée:`, err.message);
  });
}

function estEvenementClavier(event) {
  return event?.type === "keydown" || event?.type === "keyup";
}

function estEvenementCopierColler(event) {
  if (["copy", "cut", "paste"].includes(event?.type)) return true;
  if (!estEvenementClavier(event)) return false;
  const key = event.key || {};
  const modifier = key.ctrlKey || key.metaKey;
  return modifier && ["KeyC", "KeyV", "KeyX"].includes(key.code);
}

function resumerEvenements(events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  return counts;
}

chrome.windows.onBoundsChanged?.addListener?.(async (win) => {
  const found = trouverSessionParWindowId(win.id);
  if (!found) return;
  if (win.state === "fullscreen") return;
  await infractionEtUpload(found.tabId, found.session, "fenetre_redimensionnee", {
    state: win.state, width: win.width, height: win.height
  });
  try { await chrome.windows.update(win.id, { state: "fullscreen", focused: true }); } catch {}
});

chrome.system.display.onDisplayChanged.addListener(() => {
  if (SESSIONS.size === 0) return;
  verifierEcrans().catch(err => console.warn("[Pulse Hesias] verifierEcrans:", err.message));
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (SESSIONS.size === 0) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE || windowId === -1) {
    const [firstSession] = SESSIONS.values();
    const examWindowId = firstSession?.windowId;
    if (!examWindowId) return;
    if (FOCUS_TIMEOUTS.has(examWindowId)) return;
    const tid = setTimeout(async () => {
      FOCUS_TIMEOUTS.delete(examWindowId);
      const current = await chrome.windows.getLastFocused().catch(() => null);
      if (current?.id === examWindowId && current?.focused) return;
      const found = trouverSessionParWindowId(examWindowId);
      if (found) {
        await infractionEtUpload(found.tabId, found.session, "perte_focus_fenetre", {});
      }
      try { await chrome.windows.update(examWindowId, { focused: true, state: "fullscreen" }); } catch {}
    }, FOCUS_GRACE_MS);
    FOCUS_TIMEOUTS.set(examWindowId, tid);
  } else {
    if (FOCUS_TIMEOUTS.has(windowId)) {
      clearTimeout(FOCUS_TIMEOUTS.get(windowId));
      FOCUS_TIMEOUTS.delete(windowId);
    }
  }
});

// ─── Journalisation réseau bloqué ──────────────────────────────
if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
    const estTentativeIA = REGLES_BLOCAGE_IA.has(info.rule.ruleId);
    if (!estTentativeIA && !REGLES_BLOCAGE_RESEAU.has(info.rule.ruleId)) return;

    const tabId = info.request.tabId;
    if (tabId < 0) return;

    const session = SESSIONS.get(tabId) || PAGES_QCM.get(tabId);
    if (!session) return;

    const infraction = {
      type: estTentativeIA ? "requete_ia_bloquee" : "requete_bloquee",
      url: info.request.url,
      method: info.request.method,
      resourceType: info.request.type,
      ruleId: info.rule.ruleId,
      ...session,
      timestamp: Date.now()
    };

    await sauvegarderInfraction(infraction.type, {
      url: info.request.url,
      method: info.request.method,
      resourceType: info.request.type,
      ruleId: info.rule.ruleId
    });
    await uploadInfraction(infraction);
    enregistrerEvidenceAutourEvenement(tabId, session, infraction.type, infraction.timestamp).catch(err => {
      console.warn("[Pulse Hesias] Evidence réseau non enregistrée:", err.message);
    });
  });
}

// ─── Messages content.js ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id || msg.tabId;

  (async () => {
    switch (msg.type) {
      case "REQUEST_FULLSCREEN": {
        const windowId = sender.tab?.windowId;
        if (!windowId) { sendResponse({ ok: false, reason: "no_window" }); break; }
        const attempts = [
          { state: "fullscreen", focused: true },
          { state: "maximized", focused: true },
          { state: "normal", focused: true, left: 0, top: 0, width: 99999, height: 99999 }
        ];
        let lastErr = null;
        for (let i = 0; i < attempts.length; i++) {
          try {
            await chrome.windows.update(windowId, attempts[i]);
            sendResponse({ ok: true, mode: attempts[i].state });
            return;
          } catch (e) { lastErr = e; }
        }
        sendResponse({ ok: false, reason: String(lastErr?.message || lastErr) });
        break;
      }

      case "PAGE_LOADED": {
        if (!msg.data?.hasQuestions && tabId) {
          const prevSession = SESSIONS.get(tabId);
          if (prevSession) {
            await sauvegarderInfraction("examen_quitte", { url: msg.data?.url || "" });
            await uploadInfraction({ type: "examen_quitte", details: { url: msg.data?.url || "" }, ...prevSession, timestamp: Date.now() });
          }
          SESSIONS.delete(tabId);
          PAGES_QCM.delete(tabId);
          arreterBufferEvidence(tabId);
        }
        sendResponse({ ok: true });
        break;
      }

      case "QCM_DETECTED": {
        const examId = msg.data?.examId;
        const studentId = msg.data?.studentId;
        const studentName = msg.data?.studentName || null;
        if (tabId && examId && examId !== "unknown" && studentId && studentId !== "unknown") {
          PAGES_QCM.set(tabId, { examId, studentId, studentName, detectedAt: Date.now() });
        }
        sendResponse({ ok: true });
        break;
      }

      case "PRESTART_CHECK": {
        const toutes = await chrome.management.getAll();
        const tierces = toutes
          .filter(e => e.id !== PULSE_EXTENSION_ID && e.enabled && e.type === "extension")
          .map(e => ({ id: e.id, name: e.name }));
        const displays = await chrome.system.display.getInfo();
        const currentTabId = sender.tab?.id;
        const allTabs = await chrome.tabs.query({});
        const otherTabsCount = allTabs.filter(t => t.id !== currentTabId).length;
        sendResponse({
          ok: tierces.length === 0 && displays.length <= 1 && otherTabsCount === 0,
          extensions: tierces,
          screenCount: displays.length,
          otherTabsCount
        });
        break;
      }

      case "CLOSE_OTHER_TABS": {
        const currentTabId = sender.tab?.id;
        const allTabs = await chrome.tabs.query({});
        const ids = allTabs.filter(t => t.id !== currentTabId).map(t => t.id);
        if (ids.length) await chrome.tabs.remove(ids);
        sendResponse({ ok: true, closed: ids.length });
        break;
      }

      case "DISABLE_EXTENSION": {
        const extensionId = msg.extensionId;
        if (!extensionId || extensionId === PULSE_EXTENSION_ID) {
          sendResponse({ ok: false, reason: "invalid_extension" });
          break;
        }

        const extensionInfo = await chrome.management.get(extensionId).catch(() => null);
        if (!extensionInfo || extensionInfo.type !== "extension") {
          sendResponse({ ok: false, reason: "not_found" });
          break;
        }

        await chrome.management.setEnabled(extensionId, false);
        const restantes = await scannerExtensions();
        sendResponse({
          ok: true,
          disabled: { id: extensionInfo.id, name: extensionInfo.name },
          extensions: restantes.map(e => ({ id: e.id, name: e.name }))
        });
        break;
      }

      case "EXAM_START": {
        const examId = msg.data?.examId;
        const studentId = msg.data?.studentId;
        const studentName = msg.data?.studentName || null;
        if (!examId || examId === "unknown" || !studentId || studentId === "unknown") {
          sendResponse({ ok: false, reason: "unknown_ids" });
          break;
        }
        const examWindowId = sender.tab?.windowId || null;
        SESSIONS.set(tabId, { examId, studentId, studentName, startTime: Date.now(), windowId: examWindowId });
        PAGES_QCM.set(tabId, { examId, studentId, studentName, detectedAt: Date.now(), windowId: examWindowId });
        demarrerBufferEvidence(tabId);

        // Scans initiaux
        await scannerExtensions();
        await verifierEcrans();

        // Rapport environnement VM si fourni
        if (msg.data?.vmResultat) {
          const { score, niveau, signaux } = msg.data.vmResultat;
          await sauvegarderInfraction("scan_environnement", { score, niveau });
          await uploadInfraction({
            type: "scan_environnement",
            vmScore: score,
            vmNiveau: niveau,
            signaux,
            examId: msg.data.examId,
            studentId: msg.data.studentId,
            timestamp: Date.now()
          });

          // Bloquer si VM probable
          if (score >= VM_SCORE_BLOCAGE) {
            const eventTimestamp = Date.now();
            chrome.tabs.sendMessage(tabId, {
              type: "VM_DETECTED",
              score,
              signaux
            }).catch(() => {});
            enregistrerEvidenceAutourEvenement(tabId, SESSIONS.get(tabId), "vm_detectee", eventTimestamp).catch(err => {
              console.warn("[Pulse Hesias] Evidence VM non enregistrée:", err.message);
            });
          }
        }

        console.log(`[Pulse Hesias] Session démarrée — tab ${tabId} — exam ${msg.data?.examId}`);
        sendResponse({ ok: true });
        break;
      }

      case "INFRACTION": {
        await sauvegarderInfraction(msg.data.type, msg.data.details || {});
        const session = SESSIONS.get(tabId) || PAGES_QCM.get(tabId);
        const eventTimestamp = Date.now();
        const prestartTypes = new Set(["onglets_ouverts", "extensions_non_autorisees", "multi_ecran", "vm_detectee"]);
        const examActif = SESSIONS.has(tabId);
        if (session) {
          await uploadInfraction({ ...msg.data, ...session, timestamp: eventTimestamp });
          if (examActif && !prestartTypes.has(msg.data.type)) {
            enregistrerEvidenceAutourEvenement(tabId, session, msg.data.type, eventTimestamp).catch(err => {
              console.warn("[Pulse Hesias] Evidence infraction non enregistrée:", err.message);
            });
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case "INPUT_EVENTS": {
        const session = SESSIONS.get(tabId) || PAGES_QCM.get(tabId);
        const events = Array.isArray(msg.data?.events) ? msg.data.events.slice(0, 50) : [];
        if (session && events.length > 0) {
          const timestamp = Date.now();
          const payload = {
            type: "input_events",
            events,
            eventCount: events.length,
            ...session,
            timestamp
          };
          await sauvegarderInfraction("input_events", { events, eventCount: events.length });
          await uploadInfraction(payload);

          const clipboardEvents = events.filter(estEvenementCopierColler);
          const keyboardEvents = events.filter(event => estEvenementClavier(event) && !estEvenementCopierColler(event));
          const examActif = SESSIONS.has(tabId);
          const suspiciousInputs = [
            {
              type: "copier_coller_detecte",
              events: clipboardEvents,
              eventCount: clipboardEvents.length
            },
            {
              type: "clavier_detecte",
              events: keyboardEvents,
              eventCount: keyboardEvents.length
            }
          ].filter(item => item.eventCount > 0);

          for (const item of suspiciousInputs) {
            const details = {
              eventCount: item.eventCount,
              eventTypes: resumerEvenements(item.events),
              sample: item.events.slice(0, 8)
            };
            await sauvegarderInfraction(item.type, details);
            await uploadInfraction({ type: item.type, ...details, ...session, timestamp });
            if (examActif) {
              enregistrerEvidenceAutourEvenement(tabId, session, item.type, timestamp).catch(err => {
                console.warn(`[Pulse Hesias] Evidence ${item.type} non enregistrée:`, err.message);
              });
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case "EXAM_END": {
        await envoyerHeartbeats(false);
        SESSIONS.delete(tabId);
        PAGES_QCM.delete(tabId);
        arreterBufferEvidence(tabId);
        sendResponse({ ok: true });
        break;
      }

      case "GET_STATUS": {
        const session = SESSIONS.get(tabId) || null;
        const infractions = session ? await getToutesInfractions() : [];
        sendResponse({ session, infractions });
        break;
      }
    }
  })();

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  SESSIONS.delete(tabId);
  PAGES_QCM.delete(tabId);
  arreterBufferEvidence(tabId);
});

// Exam origins are injected at build time (PULSE_EXAM_ORIGINS), falling back to
// the Hesias domains when loaded unbuilt.
const EXAM_ORIGINS_FALLBACK = ["https://*.hesias.fr/*", "https://*.hesias.net/*"];
function originsExamen() {
  return (typeof PULSE_EXAM_ORIGINS !== "undefined" && Array.isArray(PULSE_EXAM_ORIGINS) && PULSE_EXAM_ORIGINS.length)
    ? PULSE_EXAM_ORIGINS
    : EXAM_ORIGINS_FALLBACK;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const horsExamen = !isAllowedUrl(changeInfo.url, originsExamen());
  if (horsExamen) {
    SESSIONS.delete(tabId);
    PAGES_QCM.delete(tabId);
    arreterBufferEvidence(tabId);
  }
});
