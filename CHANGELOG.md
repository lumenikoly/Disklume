# 0.0.3

ClearMap provides a local, visual way to explore folder sizes and review files for cleanup.

- A proportional folder and file map beside a list sorted by disk size.
- Folder navigation from the map or list, breadcrumbs, and search within the current folder.
- Open files, reveal files and folders in the system file manager, and review selected files before moving them to Trash.
- English and Russian controls with a saved language preference.
- Bounded pages of 200 items, with an aggregate tile representing the rest of the folder.
- Native identity checks and confirmed deletion-plan revisions in the Rust core.

Portable executable assets are built for Windows, macOS, and Linux, with SHA-256 checksums. See [verification](docs/VERIFICATION.md) for tested platforms and native-operation coverage.

- Back, Forward and Up navigation preserves folder search and list position.
- Folder actions on the map and list include reviewed moves to the system Trash, with complete subtree checks.
- Keyboard-friendly context menus, visible row actions and refined button feedback.
