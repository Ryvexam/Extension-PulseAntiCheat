# Pulse Hesias v3 — Extension Chrome Anti-Triche

## Nouveautés v3 vs v2

| Feature | v2 | v3 |
|---|---|---|
| Détection VM / machine virtuelle | ❌ | ✅ score 0-100 |
| Blocage si VM probable (score ≥ 60) | ❌ | ✅ |
| Rapport hardware envoyé à l'API | ❌ | ✅ |
| Whitelist ptichka.hesias.net | ❌ | ✅ |
| Whitelist CDNs LMS (Bootstrap, jQuery...) | ❌ | ✅ |
| Extraction studentId depuis le DOM Pulse | ❌ | ✅ |
| Extraction examId depuis l'URL Pulse | ❌ | ✅ |

## Signaux VM détectés

| Signal | Poids | Indicateur VM |
|---|---|---|
| WebGL Renderer (VMware, VirtualBox, llvmpipe...) | 60pts | Très fiable |
| CPU cores ≤ 2 | 15pts | Fiable |
| RAM ≤ 1 Go | 15pts | Fiable |
| Canvas perf < 20 ops/ms | 15pts | Moyen |
| Color depth < 24 | 10pts | Faible |
| Platform Linux (non-Android) | 5pts | Faible |

Score ≥ 60 → overlay bloquant + infraction loggée

## Domaines whitelistés

- `*.hesias.fr` + `*.hesias.net` — plateforme
- `ptichka.hesias.net` — assets LMS
- `maxcdn.bootstrapcdn.com` — Bootstrap
- `fonts.googleapis.com` + `fonts.gstatic.com` — polices
- `cdnjs.cloudflare.com` — highlight.js
- `code.jquery.com` — jquery-ui

## Endpoints attendus (pulse.hesias.fr)

```
POST /api/exam/screenshots   multipart: screenshot, examId, studentId, timestamp
POST /api/exam/infractions   JSON: type, examId, studentId, timestamp, [details]
POST /api/exam/environment   JSON: score, niveau, signaux[], examId, studentId, timestamp, userAgent
```

## Installation

`chrome://extensions` → Mode dev → Charger non empaquetée → dossier `pulse-hesias-v3`
