<div align="center">

# 🛡️ Pulse Hesias — Chrome Extension

**MV3 anti-cheat extension for the Hesias LMS.**
Locks the exam environment, detects cheating signals, and streams evidence to the audit backend.

> [!WARNING]
> **Unofficial project.** Not made by or affiliated with Hesias. Built by a student as an independent initiative.

[![Manifest](https://img.shields.io/badge/manifest-v3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## What it does

- 🖥️ **Fullscreen lock** — detects and re-arms fullscreen, flags fake-fullscreen and DevTools.
- 🧩 **Third-party extension gate** — blocks the exam until other extensions are disabled.
- 🪟 **Focus / tab / multi-screen guards** — alt-tab, tab switching and extra displays are logged.
- 🧪 **VM detection** — WebGL renderer, CPU/RAM, canvas benchmark → a 0–100 risk score.
- 🔒 **Network filtering** — `declarativeNetRequest` rules block AI sites; blocked requests become infractions.
- 📸 **Evidence capture** — periodic + event-windowed screenshots queued in IndexedDB and uploaded with retry.

Active only on `*.hesias.fr` and `*.hesias.net` exam pages.

---

## VM detection scoring

| Signal | Points | Reliability |
|---|---|---|
| WebGL renderer (VMware, VirtualBox, llvmpipe…) | 60 | Very high |
| CPU cores ≤ 2 | 15 | High |
| RAM ≤ 1 GB | 15 | High |
| Canvas perf < 20 ops/ms | 15 | Medium |
| Color depth < 24 | 10 | Low |
| Platform Linux (non-Android) | 5 | Low |

Score ≥ 60 → blocking overlay shown + infraction logged.

---

## File structure

```
manifest.json        MV3 manifest (permissions, content scripts, DNR rules)
background.js        Service worker: screenshot scheduling, upload queue, WS relay
content.js           Fullscreen / focus / DOM guards injected into exam pages
vmdetect.js          VM risk scoring — runs at document_start
uploader.js          IndexedDB queue + retry upload to backend
db.js                IndexedDB helpers
popup.html / popup.js  Extension popup UI
overlay.css          Blocking overlay styles
url-allow.js         Allowed-URL list for network filter
rules/rules.json     declarativeNetRequest ruleset (AI site block list)
icons/               16 / 48 / 128 px icons
_metadata/           Generated indexed rulesets (built by Chrome)
```

---

## Backend endpoints

The extension posts to the configured backend (default: `http://localhost:3000`):

| Method | Route | Body |
|---|---|---|
| `POST` | `/api/exam/screenshots` | multipart: `screenshot`, `examId`, `studentId`, `timestamp` |
| `POST` | `/api/exam/infractions` | JSON: `type`, `examId`, `studentId`, `timestamp`, `[details]` |
| `POST` | `/api/exam/environment` | JSON: `score`, `niveau`, `signaux[]`, `examId`, `studentId` |
| `POST` | `/api/exam/heartbeat` | JSON: `extensionActive`, `fullscreen`, `examId`, `studentId` |

All requests include `Authorization: Bearer <PULSE_API_TOKEN>`.

---

## Installation

### Development (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this directory

### Managed deployment (auto-update)

The backend serves a signed `.crx` and an `/updates.xml` manifest. Set the `update_url` in `manifest.json` to your backend URL and distribute the extension via Chrome policy.

See the [App-PulseAntiCheat](https://github.com/Ryvexam/App-PulseAntiCheat) backend for build and signing scripts (`scripts/pack-crx.js`, `scripts/build-extension.js`).

---

## Chrome Web Store publishing

A GitHub Actions workflow is available at `.github/workflows/publish-chrome-webstore.yml`.

Required GitHub settings:

- Repository variable `PULSE_BACKEND_URL` set to `https://anticheat.ryvexam.fr`
- Secret `CWS_SERVICE_ACCOUNT_JSON`
- Secret `CWS_PUBLISHER_ID`
- Secret `CWS_ITEM_ID`

The workflow runs on pushes to `main` and manual dispatch. It prepares a clean package from the repository root and strips `update_url` before upload so the Chrome Web Store accepts the manifest.

Privacy policy: [CONFIDENTIALITY.md](https://github.com/Ryvexam/Extension-PulseAntiCheat/blob/main/CONFIDENTIALITY.md)

---

## Whitelisted domains

Network filter rules pass through:

- `*.hesias.fr` / `*.hesias.net` — platform
- `ptichka.hesias.net` — LMS assets
- `maxcdn.bootstrapcdn.com` — Bootstrap
- `fonts.googleapis.com` / `fonts.gstatic.com` — fonts
- `cdnjs.cloudflare.com` — highlight.js
- `code.jquery.com` — jQuery UI

---

<div align="center">
<sub>Part of the Pulse Hesias anti-cheat system · MIT licensed · Handle student data responsibly.</sub>
</div>
