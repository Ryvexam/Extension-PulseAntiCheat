// ============================================================
// Pulse Hesias — IndexedDB via Dexie-like API (vanilla)
// Stockage local des screenshots en attente d'upload
// ============================================================

const DB_NAME = "PulseHesias";
const DB_VERSION = 1;
const STORE_SCREENSHOTS = "screenshots";
const STORE_INFRACTIONS = "infractions";

let db = null;

function ouvrirDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const database = e.target.result;

      if (!database.objectStoreNames.contains(STORE_SCREENSHOTS)) {
        const store = database.createObjectStore(STORE_SCREENSHOTS, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_INFRACTIONS)) {
        const store = database.createObjectStore(STORE_INFRACTIONS, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("type", "type", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
    };

    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

// ─── Screenshots ──────────────────────────────────────────────

async function sauvegarderScreenshot(blob, examId, studentId, metadata = {}) {
  const database = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_SCREENSHOTS, "readwrite");
    const store = tx.objectStore(STORE_SCREENSHOTS);
    const req = store.add({
      blob,
      examId,
      studentId,
      timestamp: metadata.timestamp || Date.now(),
      status: "pending", // pending | uploaded | failed
      retries: 0,
      kind: metadata.kind || "screenshot",
      eventType: metadata.eventType || null,
      eventTimestamp: metadata.eventTimestamp || null,
      relativeMs: Number.isFinite(metadata.relativeMs) ? Math.round(metadata.relativeMs) : null,
      tabId: metadata.tabId || null,
      tabIndex: Number.isFinite(metadata.tabIndex) ? metadata.tabIndex : null,
      tabUrl: metadata.tabUrl || null,
      tabTitle: metadata.tabTitle || null,
      tabActive: typeof metadata.tabActive === "boolean" ? metadata.tabActive : null,
      windowId: Number.isFinite(metadata.windowId) ? metadata.windowId : null
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getScreenshotsPending() {
  const database = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_SCREENSHOTS, "readonly");
    const store = tx.objectStore(STORE_SCREENSHOTS);
    const index = store.index("status");
    const req = index.getAll("pending");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function majStatutScreenshot(id, status) {
  const database = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_SCREENSHOTS, "readwrite");
    const store = tx.objectStore(STORE_SCREENSHOTS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return resolve();
      record.status = status;
      record.retries = (record.retries || 0) + 1;
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async function supprimerScreenshotsUploades() {
  const database = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_SCREENSHOTS, "readwrite");
    const store = tx.objectStore(STORE_SCREENSHOTS);
    const index = store.index("status");
    const req = index.openCursor(IDBKeyRange.only("uploaded"));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Infractions ──────────────────────────────────────────────

async function sauvegarderInfraction(type, details = {}) {
  const database = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_INFRACTIONS, "readwrite");
    const store = tx.objectStore(STORE_INFRACTIONS);
    const req = store.add({
      type,
      details,
      timestamp: Date.now()
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getToutesInfractions() {
  const database = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_INFRACTIONS, "readonly");
    const store = tx.objectStore(STORE_INFRACTIONS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
