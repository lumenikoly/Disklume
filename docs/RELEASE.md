# Release 0.0.3

ClearMap release assets contain a portable executable for each platform and SHA-256 checksums. The release notes are the `# 0.0.3` section of [CHANGELOG.md](../CHANGELOG.md). The README preview is an actual UI screenshot using synthetic test data.

## Prepare the source

Keep version `0.0.3` in these release inputs:

- `package.json` and both root version fields in `package-lock.json`.
- Workspace package version in `Cargo.toml` and the ClearMap entries in `Cargo.lock`.
- `src-tauri/tauri.conf.json`.
- The release section in `CHANGELOG.md`.

Run the checks listed in [README.md](../README.md) sequentially and record results in [VERIFICATION.md](VERIFICATION.md). Build with:

```sh
npm run tauri -- build --no-bundle
```

On Windows, the resulting executable is `target/release/clearmap.exe`. The local release directory is `release/`, containing `ClearMap_0.0.3_windows_x64.exe`, `SHA256SUMS`, and `release-notes.md`. These generated artifacts are ignored by Git.

## Publish on GitHub

Commit the prepared source and lockfiles to `main` and push them to GitHub. Run the **Release executables** workflow from `main`, passing version **0.0.3**, or use:

```sh
gh workflow run release.yml --ref main -f version=0.0.3
```

The workflow validates matching versions and the changelog, checks that `v0.0.3` is available, and runs the frontend tests including browser scenarios. Windows, macOS, and Linux jobs then run checks and build their native executables. Publication requires every build to succeed.

Release files follow this naming pattern:

```text
ClearMap_0.0.3_windows_<arch>.exe
ClearMap_0.0.3_macos_<arch>
ClearMap_0.0.3_linux_<arch>
SHA256SUMS
```

The workflow creates the `v0.0.3` tag on its source commit, publishes the notes and files, and computes checksums for the native executables. Architecture names come from the GitHub runner.

## Verification scope

Local Windows preparation and CI publication are separate results. See [VERIFICATION.md](VERIFICATION.md) for the checks actually completed. Native system Trash integration and platform-specific runtime checks are described in [MANUAL-CHECK.md](MANUAL-CHECK.md). Release binaries are unsigned; macOS notarization is not configured.
