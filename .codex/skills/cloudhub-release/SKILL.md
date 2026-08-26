---
name: cloudhub-release
description: "Release CloudHub Tools desktop builds by updating versions, validating the app, committing, tagging, and pushing when the user requests a new release."
---

# CloudHub Release

Use this skill when the user asks to publish, release, or submit a new CloudHub Tools version. The GitHub Actions workflow at `.github/workflows/release.yml` publishes desktop packages when a `v*` tag is pushed.

## Version Files

Keep the release version identical in all of these files:

- `package.json`
- `package-lock.json` (root package entry)
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` (`cloudhub-tools` package entry)
- `src-tauri/tauri.conf.json`
- `src/App.tsx` (`bundledVersion`)

Unless the user specifies otherwise, increment the patch version. Use the release tag `v<version>` and commit message `Release v<version>`.

## Workflow

1. Inspect `git status`, the current version, the latest commit, and existing tags. Do not revert or stage unrelated user changes.
2. Update all version files together. Confirm the old version no longer appears in the release metadata.
3. Run `npm run build` from the repository root and `cargo check --target-dir target-codex-check` from `src-tauri`.
4. Stage only the intended source, skill, ignore-rule, and version files. Never stage `src-tauri/target-codex-check/` or other generated build output.
5. Run `git diff --cached --check`, commit, create the tag, and push `main` followed by the tag to `origin`.
6. Report the commit hash and tag. Do not wait for the remote GitHub Actions release unless the user asks to monitor it.

## Guardrails

- Stop and report a conflict if the target tag already exists locally or on `origin`; do not force-move release tags.
- If a build, check, commit, tag, or push fails, stop before the next release mutation and report the failing command's essential error.
- A version release does not authorize unrelated refactors or deployment changes.
