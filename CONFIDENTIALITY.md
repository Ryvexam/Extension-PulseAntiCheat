# Confidentialité - Pulse Hesias

Dernière mise à jour : 4 juin 2026

## 1. Données collectées

Pulse Hesias collecte uniquement les données nécessaires à la sécurisation d'une session d'examen sur la plateforme Hesias.

Cela peut inclure :
- les identifiants d'examen et d'utilisateur fournis par la plateforme, comme `examId` et `studentId`
- les captures d'écran liées à la session d'examen
- les événements d'activité dans l'onglet, comme le changement d'onglet, la perte de focus, le plein écran, le clavier, la souris, le collage et le défilement
- les informations techniques nécessaires à l'évaluation de l'environnement, comme l'état du navigateur, des écrans, du processeur ou de la mémoire système
- les journaux réseau et l'adresse IP côté backend lorsque l'extension communique avec le serveur d'audit

## 2. Finalité

Les données sont utilisées uniquement pour :
- maintenir un environnement d'examen sécurisé
- détecter les comportements suspects ou interdits pendant l'examen
- produire des preuves d'audit
- synchroniser l'état de la session avec le backend configuré

## 3. Partage des données

Les données ne sont pas vendues.
Elles sont transmises uniquement :
- au backend d'audit configuré par l'organisation d'examen
- aux services strictement nécessaires au fonctionnement de l'extension

## 4. Conservation

Les données peuvent être stockées localement de façon temporaire avant envoi.
Les preuves et journaux peuvent ensuite être conservés sur le backend selon la politique de rétention définie par l'exploitant du système.

## 5. Sécurité

Les données sont transmises via HTTPS ou WebSocket sécurisé lorsque cela est possible.
L'extension ne charge pas de code distant.

## 6. Droits et contact

Pour toute question, demande d'accès ou de suppression, contactez le support du projet via :

- https://github.com/Ryvexam/Extension-PulseAntiCheat/issues
