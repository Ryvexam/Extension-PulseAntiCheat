// ============================================================
// Pulse Hesias v3 — Détection VM / Environnement suspect
// Score de confiance : 0 (natif) → 100 (probablement VM)
// ============================================================

const VM_RENDERERS = [
  "vmware", "virtualbox", "llvmpipe", "softpipe",
  "microsoft basic render", "swiftshader", "mesa",
  "parallels", "qemu", "virgl", "d3d12"
];

// PULSE_BACKEND_URL / PULSE_API_TOKEN are injected at build time
// (see scripts/build-extension.js).
const DEFAULT_API_BASE_URL =
  (typeof PULSE_BACKEND_URL !== "undefined" && PULSE_BACKEND_URL) || "http://localhost:3000";
const DEFAULT_API_TOKEN =
  (typeof PULSE_API_TOKEN !== "undefined" && PULSE_API_TOKEN) || "";

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

async function analyserEnvironnement() {
  const signaux = [];
  let score = 0;

  // ─── 1. WebGL Renderer (signal le plus fiable) ─────────────
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "";
        const rendererLower = renderer.toLowerCase();
        const vendorLower = vendor.toLowerCase();

        const vmMatch = VM_RENDERERS.find(v =>
          rendererLower.includes(v) || vendorLower.includes(v)
        );

        signaux.push({
          nom: "webgl_renderer",
          valeur: renderer,
          vendor,
          suspect: !!vmMatch
        });

        if (vmMatch) score += 60; // signal très fort
      }
    }
  } catch (e) {
    signaux.push({ nom: "webgl_renderer", valeur: "error", suspect: true });
    score += 20;
  }

  // ─── 2. CPU cores (VM expose souvent 1-2) ──────────────────
  const cores = navigator.hardwareConcurrency || 0;
  const coresSuspect = cores <= 2;
  signaux.push({ nom: "cpu_cores", valeur: cores, suspect: coresSuspect });
  if (coresSuspect) score += 15;

  // ─── 3. RAM (VM expose souvent 0.25-1 Go) ──────────────────
  const ram = navigator.deviceMemory || 0;
  const ramSuspect = ram > 0 && ram <= 1;
  signaux.push({ nom: "device_memory_gb", valeur: ram, suspect: ramSuspect });
  if (ramSuspect) score += 15;

  // ─── 4. Color depth (VM souvent 24 vs 32 natif) ────────────
  const colorDepth = screen.colorDepth || 0;
  const colorSuspect = colorDepth < 24;
  signaux.push({ nom: "color_depth", valeur: colorDepth, suspect: colorSuspect });
  if (colorSuspect) score += 10;

  // ─── 5. Platform ───────────────────────────────────────────
  const platform = navigator.platform || "";
  const platformSuspect = platform.toLowerCase().includes("linux") &&
    !navigator.userAgent.toLowerCase().includes("android");
  signaux.push({ nom: "platform", valeur: platform, suspect: platformSuspect });
  if (platformSuspect) score += 5; // signal faible, Linux légitime possible

  // ─── 6. Performances canvas (VM GPU lent) ──────────────────
  try {
    const perfScore = await benchmarkCanvas();
    const perfSuspect = perfScore < 20; // ops/ms
    signaux.push({ nom: "canvas_perf_ops_ms", valeur: perfScore, suspect: perfSuspect });
    if (perfSuspect) score += 15;
  } catch (e) {
    signaux.push({ nom: "canvas_perf_ops_ms", valeur: "error", suspect: false });
  }

  // ─── Score final (cap à 100) ────────────────────────────────
  score = Math.min(score, 100);

  const resultat = {
    score,
    niveau: score >= 60 ? "vm_probable" : score >= 30 ? "suspect" : "natif",
    signaux,
    timestamp: Date.now(),
    userAgent: navigator.userAgent
  };

  console.log(`[Pulse Hesias] Scan environnement — score VM: ${score}/100 (${resultat.niveau})`);
  return resultat;
}

// Benchmark simple canvas pour mesurer perf GPU
function benchmarkCanvas() {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    if (!ctx) return resolve(0);

    let ops = 0;
    const duree = 100; // ms
    const debut = performance.now();

    while (performance.now() - debut < duree) {
      ctx.fillStyle = `hsl(${ops % 360}, 50%, 50%)`;
      ctx.fillRect(0, 0, 200, 200);
      ctx.beginPath();
      ctx.arc(100, 100, 80, 0, Math.PI * 2);
      ctx.stroke();
      ops++;
    }

    const elapsed = performance.now() - debut;
    resolve(Math.round(ops / elapsed * 10));
  });
}

async function envoyerRapportEnvironnement(resultat, examId, studentId) {
  try {
    const api = await getApiConfig();
    await fetch(`${api.baseUrl}/api/exam/environment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(api.token) },
      body: JSON.stringify({ ...resultat, examId, studentId })
    });
  } catch (e) {
    console.warn("[Pulse Hesias] Rapport environnement non envoyé:", e.message);
  }
}
