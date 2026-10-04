# ClearMap

**See what's taking up space.**

ClearMap is a desktop app that turns a folder into a visual map of its disk usage. Find large files, browse their folders, and decide what to keep.

[Русский](README.ru.md) · [Downloads](https://github.com/lumenikoly/Disklume/releases) · [Release notes](CHANGELOG.md)

![ClearMap: folder size map, largest-first file list, and selected-file actions](docs/preview.png)

*Preview uses synthetic files. The app works with folders you choose on your computer.*

## Explore your space

- **Spot the largest items.** Rectangle area represents disk size; folder sizes include nested files.
- **Browse naturally.** Click a folder on the map or in the list. Use Back, Forward, Up, or the breadcrumb path; history restores your search and list position.
- **Find a file.** Search names and paths within the current folder.
- **Take action.** Open a file, reveal it in File Explorer, Finder, or your file manager, or move selected files or entire folders to Trash after reviewing them. Right-click a map tile or use the row menu for these actions.
- **Use your language.** English and Russian are available, and your preference is saved.

The map and list show the same page, with up to 200 items. An “On other pages” tile keeps the map proportional to the whole folder. Search sizes reflect matching files. Empty items remain accessible in the list.

## Get ClearMap

Download an executable for your platform from [GitHub Releases](https://github.com/lumenikoly/Disklume/releases). Release assets include Windows, macOS, and Linux executables and a `SHA256SUMS` file. Windows requires WebView2; Linux requires the Tauri system runtime libraries.

ClearMap runs locally, without accounts, telemetry, or file uploads. Files go to the system Trash only after confirmation. Moving files to Trash does not guarantee free disk space; disk sizes are estimates. See [safety](docs/SAFETY.md) and [verification](docs/VERIFICATION.md) for platform coverage and native-operation checks.

## Run from source

Requires Node.js 22+, stable Rust, and the system dependencies for Tauri:

- Windows: Visual Studio Build Tools with **Desktop development with C++**, plus WebView2.
- macOS: Xcode Command Line Tools.
- Linux: WebKitGTK 4.1 development packages, `libxdo`, OpenSSL, AppIndicator, and librsvg.

```sh
npm ci
npm run desktop
```

## Development

Run these checks sequentially:

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
cargo fmt --all -- --check
cargo clippy -p clearmap-core --all-targets --locked
cargo test -p clearmap-core --locked
npm run tauri -- build --no-bundle
```

The TypeScript UI communicates with a Rust core through a narrow Tauri bridge. Native file operations use scan, file and directory IDs; identity checks and confirmed plan revisions stay in Rust. File-operation tests use temporary directories and `TestTrash`. See [architecture](docs/ARCHITECTURE.md).

## Release 0.0.3

The `Release executables` workflow builds portable executables for Windows, macOS, and Linux, computes SHA-256 checksums, and publishes the release notes from [CHANGELOG.md](CHANGELOG.md). See the [release guide](docs/RELEASE.md) for preparation and publication.

## License

[MIT](LICENSE).
