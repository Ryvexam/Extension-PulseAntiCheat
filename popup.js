// popup.js — Pulse Hesias
function updateExtensionVersion() {
  const versionEl = document.getElementById("extension-version");
  if (!versionEl) return;
  const version = chrome.runtime.getManifest().version;
  versionEl.textContent = `v${version}`;
}


async function updateStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const isHesiasTab = tab.url && (
      tab.url.includes("hesias.fr") ||
      tab.url.includes("hesias.net")
    );

    const dot = document.getElementById("status-dot");
    const statusText = document.getElementById("status-text");
    const fullscreenStatus = document.getElementById("fullscreen-status");
    const watchStatus = document.getElementById("watch-status");

    if (isHesiasTab) {
      dot.classList.remove("inactive");
      statusText.textContent = "Actif sur domaine Hesias";

      // Requête au background pour la session
      chrome.runtime.sendMessage({ type: "GET_STATUS", tabId: tab.id }, (res) => {
        if (chrome.runtime.lastError) {
          watchStatus.textContent = "En attente";
          watchStatus.className = "info-value warn";
          return;
        }

        const session = res?.session;

        if (session) {
          watchStatus.textContent = "Active";
          watchStatus.className = "info-value ok";

          const infractions = res?.infractions?.length || 0;
          document.getElementById("infraction-num").textContent = infractions;
        } else {
          watchStatus.textContent = "En attente";
          watchStatus.className = "info-value warn";
        }
      });

      // Fullscreen status
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => !!document.fullscreenElement
      }, (results) => {
        const isFS = results?.[0]?.result;
        fullscreenStatus.textContent = isFS ? "Actif" : "Inactif";
        fullscreenStatus.className = `info-value ${isFS ? "ok" : "warn"}`;
      });

    } else {
      dot.classList.add("inactive");
      statusText.textContent = "Hors domaine Hesias";
      fullscreenStatus.textContent = "N/A";
      fullscreenStatus.className = "info-value";
      watchStatus.textContent = "N/A";
      watchStatus.className = "info-value";
    }

  } catch (err) {
    console.error("[Pulse Hesias Popup]", err);
  }
}

updateExtensionVersion();
updateStatus();
