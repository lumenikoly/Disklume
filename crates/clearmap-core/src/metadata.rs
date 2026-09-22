use crate::model::{Category, Record, Result};
use std::{
    fs::{self, Metadata},
    path::{Component, Path},
    time::SystemTime,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Identity {
    pub volume: u64,
    pub file: u128,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub identity: Option<Identity>,
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub created: Option<SystemTime>,
    pub change: Option<(i64, i64)>,
}
impl Fingerprint {
    pub fn capture(path: &Path, meta: &Metadata) -> Self {
        #[cfg(unix)]
        let change = {
            use std::os::unix::fs::MetadataExt;
            Some((meta.ctime(), meta.ctime_nsec()))
        };
        #[cfg(not(unix))]
        let change = None;
        Self {
            identity: identity(path, meta),
            len: meta.len(),
            modified: meta.modified().ok(),
            created: meta.created().ok(),
            change,
        }
    }
}
pub fn identity(_path: &Path, meta: &Metadata) -> Option<Identity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(Identity {
            volume: meta.dev(),
            file: meta.ino() as u128,
        })
    }
    #[cfg(windows)]
    {
        let _ = meta;
        match file_id::get_file_id(_path).ok()? {
            file_id::FileId::LowRes {
                volume_serial_number,
                file_index,
            } => Some(Identity {
                volume: volume_serial_number as u64,
                file: file_index as u128,
            }),
            file_id::FileId::HighRes {
                volume_serial_number,
                file_id,
            } => Some(Identity {
                volume: volume_serial_number,
                file: file_id,
            }),
            _ => None,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = meta;
        None
    }
}
pub fn allocated(_path: &Path, meta: &Metadata) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(meta.blocks().saturating_mul(512))
    }
    #[cfg(windows)]
    {
        let _ = meta;
        filesize::file_real_size(_path).ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = meta;
        None
    }
}
pub fn is_link_or_placeholder(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & (0x400 | 0x1000 | 0x40000 | 0x400000) != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}
pub fn hard_link(meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.nlink() > 1
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}
pub fn same_file_system(root: Option<Identity>, _path: &Path, meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        root.is_some_and(|identity| identity.volume == meta.dev())
    }
    #[cfg(windows)]
    {
        // Windows mount points are reparse points and are rejected before this
        // function. Do not open every ordinary directory for another volume query.
        let _ = (root, _path, meta);
        true
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (root, _path, meta);
        true
    }
}
pub fn executable(path: &Path, meta: &Metadata) -> bool {
    executable_in_category(path, meta, classify(path))
}
pub(crate) fn executable_in_category(path: &Path, meta: &Metadata, category: Category) -> bool {
    if category == Category::Executable {
        return true;
    }
    #[cfg(windows)]
    {
        // These can invoke Windows Script Host, registry import or shell tools
        // even when their visual category is source code or Other.
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if matches!(
            extension.as_str(),
            "js" | "jse"
                | "vbs"
                | "vbe"
                | "wsf"
                | "wsh"
                | "hta"
                | "reg"
                | "cpl"
                | "msc"
                | "appref-ms"
                | "application"
                | "scf"
                | "gadget"
        ) {
            return true;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}
pub fn classify(path: &Path) -> Category {
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    match ext.as_str() {
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "m4v" | "mts" | "m2ts" | "wmv" | "mpg"
        | "mpeg" => Category::Video,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "heif" | "jxl" | "tiff"
        | "tif" | "bmp" | "svg" | "dng" | "cr2" | "cr3" | "nef" | "arw" | "raw" | "psd" => {
            Category::Image
        }
        "mp3" | "flac" | "wav" | "ogg" | "opus" | "m4a" | "aac" | "aiff" | "wma" => Category::Audio,
        "pdf" | "doc" | "docx" | "odt" | "xls" | "xlsx" | "csv" | "ppt" | "pptx" | "epub"
        | "txt" | "rtf" | "pages" | "numbers" => Category::Document,
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" | "iso" | "img" | "vhd"
        | "vhdx" | "qcow2" => Category::Archive,
        "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "html" | "css" | "scss" | "go" | "c"
        | "cpp" | "h" | "hpp" | "java" | "kt" | "swift" | "md" | "toml" | "yaml" | "yml"
        | "sql" | "vue" | "svelte" | "lock" => Category::Code,
        "exe" | "msi" | "msix" | "bat" | "cmd" | "ps1" | "sh" | "bash" | "zsh" | "py" | "pyw"
        | "rb" | "pl" | "jar" | "com" | "scr" | "lnk" | "desktop" | "url" | "appimage" | "dmg"
        | "pkg" | "deb" | "rpm" => Category::Executable,
        _ => Category::Other,
    }
}
pub fn screenshot(path: &Path) -> bool {
    screenshot_in_category(path, classify(path))
}
pub(crate) fn screenshot_in_category(path: &Path, category: Category) -> bool {
    if category != Category::Image {
        return false;
    }
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    // Deliberately conservative: the name is a hint, not proof of the image's origin.
    [
        "screenshot",
        "screen shot",
        "screen_shot",
        "снимок экрана",
        "скриншот",
        "снимок екрана",
        "スクリーンショット",
        "bildschirmfoto",
    ]
    .iter()
    .any(|s| name.contains(s))
}
pub fn excluded_directory(path: &Path) -> bool {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    name == "$recycle.bin"
        || name == "system volume information"
        || name == ".trash"
        || name == ".trashes"
        || name.starts_with(".trash-")
}

/// Revalidate every path component. This reduces accidental path replacement risk;
/// a path-based OS trash API cannot provide an atomic check-and-delete guarantee.
pub fn validate_root_path(root: &Path) -> Result<()> {
    // Inspect the lexical path before canonicalize, which would hide a selected
    // symlink or junction. Check ancestors too, including at action time.
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(root)
    };
    let mut path = std::path::PathBuf::new();
    for component in absolute.components() {
        path.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let meta =
            fs::symlink_metadata(&path).map_err(|e| format!("Исходная папка недоступна: {e}"))?;
        if !meta.is_dir() || is_link_or_placeholder(&meta) {
            return Err(
                "Путь содержит ссылку, точку перенаправления или облачный файл. Операция отменена."
                    .into(),
            );
        }
    }
    Ok(())
}
pub fn validate(
    root: &Path,
    root_identity: Option<Identity>,
    record: &Record,
) -> Result<std::path::PathBuf> {
    if record.removed
        || record.fingerprint.identity.is_none()
        || record.fingerprint.modified.is_none()
    {
        return Err("Недостаточно надёжных метаданных для операции. Обновите папку.".into());
    }
    validate_root_path(root)?;
    let root_meta =
        fs::symlink_metadata(root).map_err(|e| format!("Исходная папка недоступна: {e}"))?;
    if !root_meta.is_dir()
        || is_link_or_placeholder(&root_meta)
        || root_identity.is_none()
        || identity(root, &root_meta) != root_identity
    {
        return Err("Исходная папка была заменена или стала ссылкой. Выберите её заново.".into());
    }
    let mut path = root.to_path_buf();
    let components: Vec<_> = record.relative.components().collect();
    if components.is_empty() {
        return Err("Операция с корневой папкой запрещена.".into());
    }
    for (position, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err("Некорректный путь в индексе.".into());
        };
        path.push(name);
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("Файл недоступен или был перемещён: {e}"))?;
        if is_link_or_placeholder(&meta) {
            return Err(
                "Путь содержит ссылку, точку перенаправления или облачный файл. Операция отменена."
                    .into(),
            );
        }
        if position + 1 < components.len() {
            if !meta.is_dir() {
                return Err("Родительская папка изменилась.".into());
            }
        } else if !meta.is_file() || Fingerprint::capture(&path, &meta) != record.fingerprint {
            return Err(
                "Файл изменился после сканирования. Обновите папку перед операцией.".into(),
            );
        }
    }
    Ok(path)
}

pub fn validate_directory(
    root: &Path,
    root_identity: Option<Identity>,
    relative: &Path,
) -> Result<std::path::PathBuf> {
    validate_root_path(root)?;
    let root_meta =
        fs::symlink_metadata(root).map_err(|e| format!("Исходная папка недоступна: {e}"))?;
    if !root_meta.is_dir()
        || is_link_or_placeholder(&root_meta)
        || root_identity.is_none()
        || identity(root, &root_meta) != root_identity
    {
        return Err("Исходная папка была заменена или стала ссылкой. Выберите её заново.".into());
    }
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Некорректный путь папки в индексе.".into());
        };
        path.push(name);
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("Папка недоступна или была перемещена: {e}"))?;
        if !meta.is_dir() || is_link_or_placeholder(&meta) {
            return Err("Путь папки изменился или содержит точку перенаправления.".into());
        }
    }
    Ok(path)
}
