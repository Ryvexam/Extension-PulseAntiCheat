// ============================================================
// Pulse Hesias v3 — Content Script
// Page Pulse LMS : pages QCM détectées dynamiquement
// ============================================================

(function () {
  "use strict";

  // Strip Permissions-Policy / Feature-Policy meta tags ASAP
  const stripPolicyMeta = () => {
    document.querySelectorAll(
      'meta[http-equiv="Permissions-Policy" i], meta[http-equiv="Feature-Policy" i]'
    ).forEach(m => m.remove());
  };
  stripPolicyMeta();
  new MutationObserver(stripPolicyMeta).observe(document.documentElement || document, {
    childList: true, subtree: true
  });

  const INTERVALLE_CHECK_MS = 500;
  const SEUIL_FULLSCREEN = 0.95;
  const VM_SCORE_BLOCAGE = 60; // score >= 60 → VM probable → bloquer

  let surveillanceActive = false;
  let sessionConfirmee = false;
  let intervalId = null;
  let overlayActif = null;
  let overlayType = null;
  let contexteInvalide = false;
  let journalisationInputsActive = false;
  let inputQueue = [];
  let inputFlushTimer = null;
  let pageQuestionsInitialisee = false;

  function contexteVivant() {
    return !contexteInvalide && !!(chrome.runtime && chrome.runtime.id);
  }

  function desarmerSurveillance() {
    contexteInvalide = true;
    surveillanceActive = false;
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    if (inputFlushTimer) { clearInterval(inputFlushTimer); inputFlushTimer = null; }
    flushInputEvents();
  }

  function envoyerMessage(payload) {
    if (!contexteVivant()) { desarmerSurveillance(); return; }
    try {
      chrome.runtime.sendMessage(payload);
    } catch (e) {
      if (String(e && e.message).includes("Extension context invalidated")) {
        desarmerSurveillance();
        return;
      }
      throw e;
    }
  }

  async function requeterMessage(payload) {
    if (!contexteVivant()) { desarmerSurveillance(); return null; }
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (e) {
      if (String(e && e.message).includes("Extension context invalidated")) {
        desarmerSurveillance();
      }
      return null;
    }
  }

  // ─── Extraction IDs depuis la page Pulse Hesias ───────────────

  function slugifier(str) {
    return String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
  }

  function echapperHtml(str) {
    return String(str || "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function tronquer(str, max = 120) {
    const value = String(str || "");
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }

  function selecteurElement(el) {
    if (!el || el === document || el === window) return "";
    const parts = [];
    let current = el;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }

      const classes = Array.from(current.classList || []).slice(0, 3);
      if (classes.length) part += `.${classes.join(".")}`;

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }

      parts.unshift(part);
      current = parent;
    }

    return tronquer(parts.join(" > "), 180);
  }

  function decrireCible(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) {
      return { selector: "", tag: "" };
    }

    let hrefHost = "";
    try {
      hrefHost = target.href ? new URL(target.href, location.href).host : "";
    } catch {
      hrefHost = "";
    }

    return {
      selector: selecteurElement(target),
      tag: target.tagName.toLowerCase(),
      type: tronquer(target.getAttribute("type") || "", 40),
      name: tronquer(target.getAttribute("name") || "", 80),
      role: tronquer(target.getAttribute("role") || "", 40),
      ariaLabel: tronquer(target.getAttribute("aria-label") || "", 80),
      hrefHost
    };
  }

  function decrireTouche(event) {
    const printable = event.key && event.key.length === 1;
    return {
      key: printable ? "printable" : event.key,
      code: event.code,
      printable,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      repeat: event.repeat
    };
  }

  function decrireValeur(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return {};
    const type = (target.getAttribute("type") || "").toLowerCase();
    const isTextLike = ["", "text", "search", "email", "password", "tel", "url", "number"].includes(type) ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable;

    if (type === "checkbox" || type === "radio") {
      return { checked: !!target.checked };
    }

    if (target.tagName === "SELECT") {
      return { selectedIndex: target.selectedIndex, selectedCount: Array.from(target.selectedOptions || []).length };
    }

    if (isTextLike) {
      return { valueLength: String(target.value || target.textContent || "").length };
    }

    return {};
  }

  function ajouterInputEvent(type, event, extra = {}) {
    if (!journalisationInputsActive) return;

    inputQueue.push({
      type,
      timestamp: Date.now(),
      urlPath: location.pathname,
      target: decrireCible(event.target),
      pointer: "clientX" in event ? {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        button: event.button,
        buttons: event.buttons
      } : undefined,
      ...extra
    });

    if (inputQueue.length >= 25) flushInputEvents();
  }

  function flushInputEvents() {
    if (inputQueue.length === 0) return;
    const events = inputQueue.splice(0, 50);
    envoyerMessage({ type: "INPUT_EVENTS", data: { events } });
  }

  function demarrerJournalisationInputs() {
    if (journalisationInputsActive) return;
    journalisationInputsActive = true;

    const capture = true;
    document.addEventListener("click", event => ajouterInputEvent("click", event), capture);
    document.addEventListener("dblclick", event => ajouterInputEvent("dblclick", event), capture);
    document.addEventListener("contextmenu", event => ajouterInputEvent("contextmenu", event), capture);
    document.addEventListener("pointerdown", event => ajouterInputEvent("pointerdown", event), capture);
    document.addEventListener("pointerup", event => ajouterInputEvent("pointerup", event), capture);
    document.addEventListener("keydown", event => ajouterInputEvent("keydown", event, { key: decrireTouche(event) }), capture);
    document.addEventListener("keyup", event => ajouterInputEvent("keyup", event, { key: decrireTouche(event) }), capture);
    document.addEventListener("input", event => ajouterInputEvent("input", event, { value: decrireValeur(event.target) }), capture);
    document.addEventListener("change", event => ajouterInputEvent("change", event, { value: decrireValeur(event.target) }), capture);
    document.addEventListener("focusin", event => ajouterInputEvent("focusin", event), capture);
    document.addEventListener("focusout", event => ajouterInputEvent("focusout", event), capture);
    document.addEventListener("copy", event => ajouterInputEvent("copy", event), capture);
    document.addEventListener("cut", event => ajouterInputEvent("cut", event), capture);
    document.addEventListener("paste", event => ajouterInputEvent("paste", event), capture);
    document.addEventListener("dragstart", event => ajouterInputEvent("dragstart", event), capture);
    document.addEventListener("drop", event => ajouterInputEvent("drop", event), capture);
    window.addEventListener("beforeunload", flushInputEvents);

    inputFlushTimer = setInterval(flushInputEvents, 5000);
  }

  function extraireStudentId() {
    const spans = document.querySelectorAll(".navbar-right span");
    for (const span of spans) {
      const match = span.textContent.match(/ID Booster\s*:\s*(\d+)/);
      if (match) return match[1];
    }
    return "unknown";
  }

  function extraireStudentName() {
    const spans = document.querySelectorAll(".navbar-right li span");
    for (const span of spans) {
      const txt = (span.textContent || "").trim();
      if (!txt || /ID Booster/i.test(txt)) continue;
      if (/^[A-ZÀ-Ÿ][\p{L}'-]+(\s+[A-ZÀ-Ÿ][\p{L}'-]+)+$/u.test(txt)) return txt;
    }
    return null;
  }

  function extraireExamId() {
    // URL : /exam/123, /mcq/123, etc.
    const match = window.location.pathname.match(/\/(?:exam|mcq)\/([a-zA-Z0-9_-]+)/);
    if (match && match[1] !== "train") return match[1];
    // Fallback: data-id sur le panel-body
    const panel = document.querySelector(".panel-body[data-id]");
    if (panel && panel.dataset.id) return panel.dataset.id;
    // Fallback QCM: certaines pages questions sont servies sur /exam ou /mcq.
    const h1 = document.querySelector("h1")?.textContent || "";
    const apiMatch = Array.from(document.scripts)
      .map(script => script.textContent || "")
      .join("\n")
      .match(/mcqexamapi\/([a-zA-Z0-9_-]+)/);
    const questionMatch = Array.from(document.scripts)
      .map(script => script.textContent || "")
      .join("\n")
      .match(/"id"\s*:\s*(\d+)/);
    const fallback = slugifier([
      "mcq",
      apiMatch?.[1] || "",
      h1.replace(/\s+-\s+Correct:.*/, ""),
      questionMatch?.[1] || ""
    ].filter(Boolean).join("_"));
    if (fallback) return fallback;
    return "unknown";
  }

  // ─── Communication background ─────────────────────────────────

  function logInfraction(type, details = {}) {
    if (!sessionConfirmee) return;
    envoyerMessage({ type: "INFRACTION", data: { type, details } });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "EXTENSION_DETECTED":
        afficherOverlayExtension(msg.extensions);
        break;
      case "EXTENSION_CLEARED":
        if (overlayType === "extension") {
          supprimerOverlay();
          if (!sessionConfirmee && detecterPageQuestions()) {
            afficherOverlayDemarrage(window.__phVmResultat?.score || 0);
          }
        }
        break;
      case "MULTI_SCREEN_DETECTED":
        afficherOverlayMultiScreen(msg.count);
        break;
      case "FORCE_FULLSCREEN":
        if (!document.fullscreenElement) afficherOverlayViolation("fullscreen");
        break;
      case "VM_DETECTED":
        afficherOverlayVM(msg.score, msg.signaux || []);
        logInfraction("vm_detectee", { score: msg.score });
        break;
    }
  });

  // ─── Fullscreen ───────────────────────────────────────────────

  function estEnFullscreen() {
    if (document.fullscreenElement) return true;
    const dpr = window.devicePixelRatio || 1;
    const ratioW = (window.innerWidth * dpr) / (screen.width * dpr);
    const ratioH = (window.innerHeight * dpr) / (screen.height * dpr);
    const estMac = /mac/i.test(navigator.platform);
    const seuil = estMac ? 0.93 : SEUIL_FULLSCREEN;
    return ratioW >= seuil && ratioH >= seuil;
  }

  async function demanderFullscreen() {
    // Try DOM API first — user gesture from button click is still valid here.
    try {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
      if (req) {
        await req.call(el, { navigationUI: "hide" });
        supprimerOverlay();
        if (sessionConfirmee && !surveillanceActive) demarrerSurveillance();
        return;
      }
    } catch (_) { /* fallback ↓ */ }

    // Fallback: ask background to force fullscreen via chrome.windows.update.
    const resp = await requeterMessage({ type: "REQUEST_FULLSCREEN" });
    if (resp?.ok) {
      supprimerOverlay();
      if (sessionConfirmee && !surveillanceActive) demarrerSurveillance();
    } else {
      console.warn("[Pulse Hesias] Fullscreen refusé:", resp?.reason);
    }
  }

  // ─── Overlays ─────────────────────────────────────────────────

  function creerOverlayBase(id) {
    supprimerOverlay();
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
    overlayActif = el;
    return el;
  }

  function supprimerOverlay() {
    if (overlayActif) { overlayActif.remove(); overlayActif = null; overlayType = null; }
  }

  // Overlay démarrage — affiché sur la page QCM Pulse
  function afficherOverlayDemarrage(vmScore = 0) {
    if (overlayActif) return;
    overlayType = "start";
    const overlay = creerOverlayBase("ph-overlay-start");
    overlay.innerHTML = `
      <div class="ph-card">
        <div class="ph-logo">
          <div class="ph-pulse-ring"></div>
          <div class="ph-pulse-ring ph-ring-2"></div>
          <div class="ph-icon">⬡</div>
        </div>
        <h1 class="ph-title">Pulse Hesias</h1>
        <p class="ph-subtitle">Environnement d'examen sécurisé v3</p>
        <div class="ph-rules">
          <div class="ph-rule"><span class="ph-rule-icon">🖥️</span><span>Plein écran obligatoire et surveillé</span></div>
          <div class="ph-rule"><span class="ph-rule-icon">🧩</span><span>Extensions tierces bloquées</span></div>
          <div class="ph-rule"><span class="ph-rule-icon">📸</span><span>Captures d'écran toutes les 30 secondes</span></div>
        </div>
        <button id="ph-btn-start">
          <span>Démarrer l'examen</span>
          <span class="ph-btn-arrow">→</span>
        </button>
        <p class="ph-disclaimer">En cliquant, vous acceptez les conditions de surveillance</p>
      </div>
    `;
    document.getElementById("ph-btn-start").addEventListener("click", async () => {
      const examId = extraireExamId();
      const studentId = extraireStudentId();
      const studentName = extraireStudentName();
      if (examId === "unknown" || studentId === "unknown") {
        console.warn("[Pulse Hesias] Pas dans un examen — surveillance non démarrée");
        return;
      }
      const fsPromise = requeterMessage({ type: "REQUEST_FULLSCREEN" });
      const check = await requeterMessage({ type: "PRESTART_CHECK" });
      if (check && Array.isArray(check.extensions) && check.extensions.length > 0) {
        envoyerMessage({
          type: "INFRACTION",
          data: { type: "extensions_non_autorisees", details: { extensions: check.extensions } }
        });
        afficherOverlayExtension(check.extensions);
        return;
      }
      if (check?.screenCount > 1) {
        envoyerMessage({
          type: "INFRACTION",
          data: { type: "multi_ecran", details: { count: check.screenCount } }
        });
        afficherOverlayMultiScreen(check.screenCount);
        return;
      }
      const vmResultat = window.__phVmResultat || null;
      const resp = await requeterMessage({
        type: "EXAM_START",
        data: { examId, studentId, studentName, vmResultat }
      });
      if (!resp || !resp.ok) {
        console.warn("[Pulse Hesias] EXAM_START refusé");
        return;
      }
      if (vmResultat) {
        await envoyerRapportEnvironnement(vmResultat, examId, studentId);
      }
      sessionConfirmee = true;
      await fsPromise;
      supprimerOverlay();
      if (!surveillanceActive) demarrerSurveillance();
    });
  }

  // Overlay VM détectée
  function afficherOverlayVM(score, signaux) {
    overlayType = "vm";
    const signauxSuspects = signaux.filter(s => s.suspect);
    const items = signauxSuspects.map(s =>
      `<li class="ph-ext-item">⚠️ ${s.nom} : <strong>${s.valeur}</strong></li>`
    ).join("");

    const overlay = creerOverlayBase("ph-overlay-vm");
    overlay.innerHTML = `
      <div class="ph-card ph-card-warning">
        <div class="ph-warning-icon">🖥️</div>
        <h2 class="ph-title">Environnement non autorisé</h2>
        <p class="ph-subtitle">Une machine virtuelle ou un environnement émulé a été détecté.<br>Score de risque : <strong>${score}/100</strong></p>
        <ul class="ph-ext-list">${items}</ul>
        <p class="ph-subtitle" style="margin-top:16px">Contactez votre surveillant pour continuer.</p>
        <p class="ph-disclaimer" style="margin-top:12px">Cette infraction a été enregistrée.</p>
      </div>
    `;
  }

  function afficherOverlayViolation(raison = "fullscreen") {
    if (overlayType === "extension" || overlayType === "multiscreen" || overlayType === "vm") return;
    overlayType = "violation";
    const messages = {
      fullscreen: { titre: "Mode plein écran quitté", desc: "Cliquez pour revenir en plein écran.<br>Cet événement a été enregistré." },
      faux_fullscreen: { titre: "Plein écran invalide", desc: "Simulation de plein écran détectée.<br>Fermez les DevTools et reprenez." },
      devtools: { titre: "DevTools ouverts", desc: "Fermez les DevTools pour continuer l'examen.<br>Cet événement a été enregistré." }
    };
    const msg = messages[raison] || messages.fullscreen;
    const sansBouton = raison === "devtools";
    const overlay = creerOverlayBase("ph-overlay-violation");
    overlay.innerHTML = `
      <div class="ph-card ph-card-warning">
        <div class="ph-warning-icon">⚠️</div>
        <h2 class="ph-title">${msg.titre}</h2>
        <p class="ph-subtitle">${msg.desc}</p>
        ${sansBouton ? "" : '<button id="ph-btn-resume"><span>Reprendre l\'examen</span><span class="ph-btn-arrow">→</span></button>'}
      </div>
    `;
    if (!sansBouton) {
      document.getElementById("ph-btn-resume").addEventListener("click", demanderFullscreen);
    }
  }

  function afficherOverlayExtension(extensions) {
    overlayType = "extension";
    const liste = extensions
      .map(e => `
        <li class="ph-ext-item ph-ext-action-item">
          <span>🧩 <strong>${echapperHtml(e.name)}</strong></span>
          <button class="ph-btn-disable-extension" data-extension-id="${echapperHtml(e.id)}">
            Désactiver
          </button>
        </li>
      `)
      .join("");
    const total = extensions.length;
    const overlay = creerOverlayBase("ph-overlay-extension");
    overlay.innerHTML = `
      <div class="ph-card ph-card-warning">
        <div class="ph-warning-icon">🧩</div>
        <h2 class="ph-title">${total} extension${total > 1 ? "s" : ""} à désactiver</h2>
        <p class="ph-subtitle">Pour démarrer ce QCM, désactivez exactement ${total > 1 ? "ces extensions" : "cette extension"}, puis revenez sur cette page :</p>
        <ul class="ph-ext-list">${liste}</ul>
        <p id="ph-extension-status" class="ph-disclaimer" style="margin-top:12px">Vous pouvez aussi passer par chrome://extensions si Chrome refuse une désactivation automatique.</p>
      </div>
    `;

    overlay.querySelectorAll(".ph-btn-disable-extension").forEach(button => {
      button.addEventListener("click", async () => {
        const extensionId = button.getAttribute("data-extension-id");
        button.disabled = true;
        button.textContent = "Désactivation...";
        const status = document.getElementById("ph-extension-status");

        const response = await requeterMessage({ type: "DISABLE_EXTENSION", extensionId });
        if (response?.ok) {
          if (Array.isArray(response.extensions) && response.extensions.length > 0) {
            afficherOverlayExtension(response.extensions);
          } else {
            supprimerOverlay();
            if (!sessionConfirmee && detecterPageQuestions()) {
              afficherOverlayDemarrage(window.__phVmResultat?.score || 0);
            }
          }
          return;
        }

        button.disabled = false;
        button.textContent = "Réessayer";
        if (status) {
          status.textContent = "Désactivation refusée par Chrome. Ouvrez chrome://extensions et désactivez-la manuellement.";
        }
      });
    });
  }

  function afficherOverlayOnglets(total) {
    overlayType = "onglets";
    const overlay = creerOverlayBase("ph-overlay-onglets");
    overlay.innerHTML = `
      <div class="ph-card ph-card-warning">
        <div class="ph-warning-icon">📑</div>
        <h2 class="ph-title">${total} onglet${total > 1 ? "s" : ""} à fermer</h2>
        <p class="ph-subtitle">Fermez ${total > 1 ? "ces onglets" : "cet onglet"} pour démarrer l'examen.</p>
        <button id="ph-btn-close-tabs"><span>Fermer automatiquement</span><span class="ph-btn-arrow">→</span></button>
      </div>
    `;
    document.getElementById("ph-btn-close-tabs").addEventListener("click", async () => {
      const resp = await requeterMessage({ type: "CLOSE_OTHER_TABS" });
      if (resp?.ok) {
        supprimerOverlay();
        const check = await requeterMessage({ type: "PRESTART_CHECK" });
        if (!check?.otherTabsCount) {
          afficherOverlayDemarrage(window.__phVmResultat?.score || 0);
        } else {
          afficherOverlayOnglets(check.otherTabsCount);
        }
      }
    });
  }

  function afficherOverlayMultiScreen(count) {
    overlayType = "multiscreen";
    const overlay = creerOverlayBase("ph-overlay-multiscreen");
    overlay.innerHTML = `
      <div class="ph-card ph-card-warning">
        <div class="ph-warning-icon">🖥️</div>
        <h2 class="ph-title">${count} écrans détectés</h2>
        <p class="ph-subtitle">Déconnectez les écrans supplémentaires et rechargez la page.</p>
        <p class="ph-disclaimer" style="margin-top:12px">Cette infraction a été enregistrée.</p>
      </div>
    `;
  }

  // ─── Surveillance continue ────────────────────────────────────

  let wasmCore = null;
  let wasmTried = false;
  async function chargerWasm() {
    if (wasmTried) return wasmCore;
    wasmTried = true;
    try {
      if (!chrome?.runtime?.id) return null;
      const url = chrome.runtime.getURL("core.wasm");
      if (!url || url.includes("invalid")) return null;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = await resp.arrayBuffer();
      const mod = await WebAssembly.instantiate(bytes, { env: { abort: () => {} } });
      wasmCore = mod.instance.exports;
    } catch (e) {
      wasmCore = null;
    }
    return wasmCore;
  }

  function hexFromBytes(view) {
    let s = "";
    for (let i = 0; i < view.length; i++) s += view[i].toString(16).padStart(2, "0");
    return s;
  }

  async function snapshotIntegrite() {
    const cibles = document.querySelectorAll("#mcq, #mcq .docbook, [data-id]");
    if (cibles.length === 0) return null;
    const text = Array.from(cibles).map(el => el.outerHTML).join("|");
    const buffer = new TextEncoder().encode(text);
    const core = await chargerWasm();
    if (core && core.sha256 && core.alloc && core.memory) {
      try {
        const ptr = core.alloc(buffer.length);
        new Uint8Array(core.memory.buffer, ptr, buffer.length).set(buffer);
        const outPtr = core.sha256(ptr, buffer.length);
        const out = new Uint8Array(core.memory.buffer, outPtr, 32).slice();
        if (core.free) { core.free(ptr); core.free(outPtr); }
        return hexFromBytes(out);
      } catch (_) { /* fallback ↓ */ }
    }
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return hexFromBytes(new Uint8Array(hash));
  }

  let hashIntegrite = null;
  let integriteCheckEnCours = false;
  async function verifierIntegrite() {
    if (integriteCheckEnCours) return;
    integriteCheckEnCours = true;
    try {
      const current = await snapshotIntegrite();
      if (!current) return;
      if (hashIntegrite === null) { hashIntegrite = current; return; }
      if (current !== hashIntegrite) {
        const prev = hashIntegrite;
        hashIntegrite = current;
        logInfraction("dom_tamper", { prevHash: prev, currHash: current });
      }
    } finally {
      integriteCheckEnCours = false;
    }
  }

  function examenTermine() {
    const noMcq = !document.querySelector("#mcq.docbook, #mcq");
    const hasResultat = !!document.querySelector(".final-score, #score, .exam-finished, .resultats-examen");
    return noMcq || hasResultat;
  }

  let devtoolsOuvert = false;
  function detecterDevTools() {
    const dw = window.outerWidth - window.innerWidth;
    const dh = window.outerHeight - window.innerHeight;
    const ouvert = dw > 160 || dh > 160;
    if (ouvert && !devtoolsOuvert) {
      devtoolsOuvert = true;
      logInfraction("devtools_ouvert", { dw, dh });
      afficherOverlayViolation("devtools");
    } else if (!ouvert && devtoolsOuvert) {
      devtoolsOuvert = false;
      if (overlayType === "violation") supprimerOverlay();
    }
  }

  function demarrerSurveillance() {
    surveillanceActive = true;
    verifierIntegrite();
    setInterval(verifierIntegrite, 5000);
    setInterval(detecterDevTools, 1000);

    intervalId = setInterval(() => {
      if (overlayType) return;
      if (examenTermine()) return;
      if (!estEnFullscreen()) {
        const estFaux = !document.fullscreenElement &&
          window.innerWidth / screen.width > 0.85 &&
          window.innerHeight / screen.height > 0.85;
        const raison = estFaux ? "faux_fullscreen" : "fullscreen";
        logInfraction(`${raison}_exit`, {
          innerW: window.innerWidth, innerH: window.innerHeight,
          screenW: screen.width, screenH: screen.height
        });
        afficherOverlayViolation(raison);
      }
    }, INTERVALLE_CHECK_MS);

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && surveillanceActive && !examenTermine()) {
        logInfraction("fullscreen_api_exit");
        afficherOverlayViolation("fullscreen");
      } else if (document.fullscreenElement && overlayType === "violation") {
        supprimerOverlay();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) logInfraction("tab_hidden");
    });

    window.addEventListener("blur", () => logInfraction("window_blur"));

    console.log("[Pulse Hesias] Surveillance v3 démarrée");
  }

  // ─── Init ─────────────────────────────────────────────────────

  function scriptContient(pattern) {
    return Array.from(document.scripts).some(script =>
      pattern.test(script.textContent || "") || pattern.test(script.src || "")
    );
  }

  function detecterPageQuestions() {
    const hasMcqContainer = !!document.querySelector("#mcq.docbook, #mcq");
    const hasQuestionControls = !!document.querySelector("#prevQuestion, #nextQuestion");
    const hasActionControls = !!document.querySelector("#revealAnswer, #endExam, #finishSession, #actionContainer");
    const hasQuestionsData = scriptContient(/\bvar\s+questions\s*=\s*\[/);
    const hasMcqRuntime = scriptContient(/\bnew\s+Mcq\s*\(/) ||
      scriptContient(/mcqexamapi/) ||
      scriptContient(/\/js\/mcq\.js(?:\?|$)/);

    const hasAnswers = document.querySelectorAll('input[name="answer"]').length > 0;
    const hasQandA = !!document.querySelector("#mcq table.qandaentry, #mcq tr.question, #mcq tr.answer");
    return hasMcqContainer && (
      hasQuestionsData ||
      hasMcqRuntime ||
      hasAnswers ||
      hasQandA ||
      (hasQuestionControls && hasActionControls)
    );
  }

  async function initSurPageQuestions() {
    if (pageQuestionsInitialisee) return;
    if (!detecterPageQuestions()) return;
    pageQuestionsInitialisee = true;

    let vmResultat = null;
    try { vmResultat = await analyserEnvironnement(); } catch (e) { console.warn("[Pulse Hesias] VM scan échoué", e); }

    let examId = "unknown", studentId = "unknown", studentName = null;
    try { examId = extraireExamId(); } catch {}
    try { studentId = extraireStudentId(); } catch {}
    try { studentName = extraireStudentName(); } catch {}
    window.__phVmResultat = vmResultat;
    await requeterMessage({ type: "QCM_DETECTED", data: { examId, studentId, studentName } });
    demarrerJournalisationInputs();

    if (vmResultat?.score >= VM_SCORE_BLOCAGE) {
      await envoyerRapportEnvironnement(vmResultat, examId, studentId);
      envoyerMessage({
        type: "INFRACTION",
        data: { type: "vm_detectee", details: { score: vmResultat.score, signaux: vmResultat.signaux || [] } }
      });
      afficherOverlayVM(vmResultat.score, vmResultat.signaux || []);
      return;
    }

    const check = await requeterMessage({ type: "PRESTART_CHECK" });
    if (check && Array.isArray(check.extensions) && check.extensions.length > 0) {
      envoyerMessage({
        type: "INFRACTION",
        data: { type: "extensions_non_autorisees", details: { extensions: check.extensions } }
      });
      afficherOverlayExtension(check.extensions);
      return;
    }
    if (check?.screenCount > 1) {
      envoyerMessage({
        type: "INFRACTION",
        data: { type: "multi_ecran", details: { count: check.screenCount } }
      });
      afficherOverlayMultiScreen(check.screenCount);
      return;
    }
    if (check && check.otherTabsCount > 0) {
      envoyerMessage({
        type: "INFRACTION",
        data: { type: "onglets_ouverts", details: { count: check.otherTabsCount } }
      });
      afficherOverlayOnglets(check.otherTabsCount);
      return;
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => afficherOverlayDemarrage(vmResultat?.score || 0));
    } else {
      afficherOverlayDemarrage(vmResultat?.score || 0);
    }

    // Rapport VM envoyé au click démarrer (dans le handler du bouton).
  }

  function init() {
    envoyerMessage({ type: "PAGE_LOADED", data: { hasQuestions: detecterPageQuestions(), url: location.pathname } });
    let tentatives = 0;
    const tenterInit = () => {
      initSurPageQuestions();
      if (!pageQuestionsInitialisee && tentatives < 20) {
        tentatives += 1;
        setTimeout(tenterInit, 500);
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", tenterInit, { once: true });
    } else {
      tenterInit();
    }
  }

  init();
})();
