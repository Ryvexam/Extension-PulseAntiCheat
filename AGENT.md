# Agent

## Role

This repository contains the Pulse Hesias anti-cheat system and its Chrome extension.
Treat the app backend, extension, CI, release packaging, and Chrome Web Store publishing as one coordinated product.

## Operating Rules

- Keep the backend app, extension, and CI in sync.
- Before merging anything to `main`, bump the extension version in `manifest.json`.
- When the version changes, add or update `CHANGELOG.md` with the delta from the previous release.
- For release work, include both the source change and the release metadata update in the same branch.
- Do not ship a release from `main` without a matching changelog entry.
- Keep `README.md` aligned with the current release and publishing flow.
- Keep GitHub Actions, GitHub secrets, and repository variables aligned with the current workflow.

## Versioning

- `manifest.json` is the source of truth for the extension version.
- Increment the patch version for routine fixes and CI/release changes.
- If the change is a larger functional release, adjust the version according to the project’s release convention, but do not skip the version bump.
- Chrome Web Store uploads must always use a package whose manifest version is newer than the last published item.

## Changelog

- `CHANGELOG.md` must describe what changed compared with the previous version.
- Prefer concise bullets grouped by release version.
- Mention user-visible changes, CI/release changes, and any packaging or privacy-policy updates.
- If a release is prepared from `main`, the changelog update is required in the same commit set.

## Release Workflow

## Chrome Web Store Automation

- The Chrome Web Store workflow auto-generates the upload package version from the manifest major/minor plus the Git commit count, so future pushes to main should produce a strictly increasing patch version as long as history is not rewritten.
- The workflow removes `update_url` from the package manifest before uploading to Chrome Web Store; do not add `update_url` back to the store package.
- If Chrome Web Store returns `FAILED_PRECONDITION` / `NOT_UPDATEABLE` with `You may not edit or publish an item that is in review`, do not diagnose IAM, secrets, or token generation first. The item is already in review and must be approved, rejected, or withdrawn before another upload can succeed.
- If Chrome Web Store returns `PERMISSION_DENIED` for `publishers/.../items/...`, verify Chrome Web Store Developer Dashboard access for the service account and confirm `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`; Google Cloud IAM alone is not enough.
- The current workflow uses `CWS_SERVICE_ACCOUNT_JSON` to generate a Chrome Web Store scoped access token directly, then uploads and publishes through the Chrome Web Store API.

- Use the repository root as the extension package source unless the workflow says otherwise.
- The Chrome Web Store package must exclude repo-only files such as `.git/`, `.github/`, docs, and local artifacts.
- Keep privacy-policy and publishing links in sync between the repo, README, and the Chrome Web Store listing.

## CI Ownership

- The extension and backend CI are part of the same release system.
- When modifying CI, check whether the change affects versioning, changelog generation, package contents, or the Chrome Web Store upload path.
- Preserve existing secrets and repository variables unless the workflow explicitly requires new ones.

## Default Behavior

- If a change touches production behavior, update the changelog.
- If a change touches the release or publish flow, update the version and validate the package shape.
- If a change affects privacy or data handling, update the privacy policy text and the store listing references together.
