# Verification — ClearMap 0.0.3

Date: October 4, 2026. Environment: Windows x64, Node.js 22.18.0, Rust/Cargo 1.98.1, TypeScript 5.8.3, Playwright 1.55.1 / Chromium.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 30 tests passed |
| `npm run test:e2e` | 24 browser scenarios passed |
| `cargo fmt --all`, then `cargo fmt --all -- --check` | Passed |
| `cargo clippy -p clearmap-core --all-targets --locked -- -D warnings` | Passed without warnings |
| `cargo test -p clearmap-core --locked` | 42 Windows tests passed |
| `npm run tauri -- build --no-bundle` | Passed; Windows x64 executable built |
| Windows executable version and startup | FileVersion and ProductVersion are 0.0.3; process remained running during a five-second smoke check |
| Release workflow YAML | Parsed locally; browser gate and build/publication dependencies checked |
| Release version inputs and README links | Consistent; local links resolve |
| Release artifact checksum | SHA-256 generated; release copy matches the built executable |
| README preview | Captured and visually checked at 1360×900, with English controls and synthetic data |

## UI and geometry

The UI presents a proportional folder/file map beside a largest-first list, folder navigation, search, and selected-file actions. The README [preview](preview.png) shows the folder overview and file actions together. The [compact window](compact.png) documents the 960×650 layout. The [folder action menu](folder-actions.png) shows navigation and contextual actions. Additional screenshots cover [overview RU](interface.png), [overview EN](interface-en.png), [selected file RU](folders.png), and [selected file EN](folders-en.png).

Geometry tests cover area proportional to size, total map coverage, deterministic output, finite coordinates, and non-overlapping tiles. Zero-byte entries remain accessible in the list without map area. A page contains up to 200 items; the map can add one tile for the size of the other pages. Browser checks compare this tile's area with its share of the folder.

Browser scenarios cover map and list navigation, breadcrumbs and Alt+↑, synchronized selection, search and empty results, zero-byte files, pagination, selection from a focused checkbox, and English/Russian language changes preserving names and plans. They also cover opening and revealing synthetic files, executable confirmation, keyboard context menus, row actions, and confirmed removal of files and complete folders. Back/Forward restore search, page and scroll; new navigation clears pending search and branches history. Successful folder moves return to a surviving parent and prune removed history entries, including when completion precedes the command response. Double-clicking a folder enters a single level without opening newly displayed files. Delete opens plan review; Cancel and Escape leave files in place. Confirmed operations use the plan revision.

Supported window checks use 960×650, 1360×940, and 1920×1080 with the action panel visible. Browser tests use `DemoBackend` and never invoke native file APIs.

## Native core

Rust file-operation tests use temporary directories and `TestTrash`, never the real system Trash. They verify stale revisions and session IDs, changed and missing files, journal and Trash errors, cancellation, junctions, hard links, folder totals, and bounded pages. Directory tests cover complete-tree moves including empty directories, parent/child plan overlap, mixed file/folder pagination, root protection, replacement identity checks, missing or new files/directories, changed files, excluded subtrees and Windows junctions.

All release version inputs are set to 0.0.3: npm manifests, workspace package version, ClearMap Cargo lock entries, and Tauri configuration. The release changelog and README links are checked locally. GitHub's release workflow validates versions, runs browser scenarios, and builds native binaries for its platform matrix.

## Scope and limits

- Windows is the locally tested platform. macOS and Linux builds and runtime behavior remain unverified here; the configured CI matrix is not a completed run.
- System folder-picker interaction, external-file opening, native file-manager behavior, and real Trash/recovery operations were not manually exercised. See [MANUAL-CHECK.md](MANUAL-CHECK.md).
- Executables are unsigned, and macOS notarization is not configured.
- Performance and memory on 100,000 or one million real files were not measured. Dependency security audits were not run during this release preparation.
- GitHub Actions, remote tagging, and GitHub Release publication have not been performed.

Builds and browser tests run sequentially because both recreate `dist/`. The test server uses 127.0.0.1:1421 and accepts `CLEARMAP_TEST_PORT` for another port. Playwright starts its own server.

Local release assets are recorded in [RELEASE.md](RELEASE.md). The prepared Windows x64 executable, SHA256SUMS, and release-notes.md are in `release/`. The startup smoke check confirms process startup only; it does not exercise native file actions.

Local Windows executable SHA-256: `a2e552df78f49d5fdd89ba4042a132eb8f161625c94382b5a40dc600d12f1d30`.
