use crate::{
    engine::Session,
    metadata,
    model::{Phase, Record},
};
use std::{
    fs,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use walkdir::WalkDir;

pub(crate) fn scan(session: Arc<Session>) {
    let root = session
        .index
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .root
        .clone();
    let mut walker = WalkDir::new(&root)
        .follow_links(false)
        .same_file_system(true)
        .max_open(32)
        .into_iter();
    let mut batch = Vec::with_capacity(256);
    let mut directory_batch = Vec::with_capacity(256);
    let mut last_flush = Instant::now();
    while let Some(entry) = walker.next() {
        if session.cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                session.with_index(|index| {
                    index.issue(
                        e.path()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        format!("Не удалось прочитать: {e}"),
                    )
                });
                continue;
            }
        };
        let path = entry.path();
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) => {
                session.with_index(|i| {
                    i.issue(
                        path.to_string_lossy().into_owned(),
                        format!("Метаданные недоступны: {e}"),
                    )
                });
                continue;
            }
        };
        if metadata::is_link_or_placeholder(&meta) {
            if entry.file_type().is_dir() {
                walker.skip_current_dir();
            }
            session.with_index(|i| i.skipped_links += 1);
            continue;
        }
        if meta.is_dir() {
            if metadata::excluded_directory(path) || entry.depth() >= 512 {
                walker.skip_current_dir();
                session.with_index(|i| i.skipped_special += 1);
            } else if let Ok(relative) = path.strip_prefix(&root) {
                directory_batch.push(relative.to_path_buf());
            }
            if directory_batch.len() >= 256 || last_flush.elapsed() >= Duration::from_millis(120) {
                flush(&session, &mut batch, &mut directory_batch);
                last_flush = Instant::now();
            }
            continue;
        }
        if !meta.is_file() {
            session.with_index(|i| i.skipped_special += 1);
            continue;
        }
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        batch.push(Record {
            id: 0,
            relative: relative.to_path_buf(),
            category: metadata::classify(path),
            screenshot: metadata::screenshot(path),
            fingerprint: metadata::Fingerprint::capture(path, &meta),
            allocated: metadata::allocated(path, &meta),
            allocated_charge: 0,
            hard_link: metadata::hard_link(&meta),
            executable: metadata::executable(path, &meta),
            duplicate_group: None,
            removed: false,
        });
        if batch.len() >= 256
            || directory_batch.len() >= 256
            || last_flush.elapsed() >= Duration::from_millis(120)
        {
            flush(&session, &mut batch, &mut directory_batch);
            last_flush = Instant::now();
        }
    }
    flush(&session, &mut batch, &mut directory_batch);
    session.with_index(|index| {
        index.elapsed_ms = index.started.elapsed().as_millis() as u64;
        index.phase = if session.cancel.load(Ordering::Relaxed) {
            Phase::Cancelled
        } else {
            Phase::Ready
        };
        index.current_path.clear();
        index.revision += 1;
    });
}
fn flush(
    session: &Session,
    batch: &mut Vec<Record>,
    directory_batch: &mut Vec<std::path::PathBuf>,
) {
    if batch.is_empty() && directory_batch.is_empty() {
        return;
    }
    session.with_index(|index| {
        index.current_path = batch
            .last()
            .map(|r| r.relative.to_string_lossy().into_owned())
            .unwrap_or_default();
        for record in batch.drain(..) {
            index.push(record);
        }
        for directory in directory_batch.drain(..) {
            index.register_directory(&directory);
        }
        index.revision += 1;
    });
}
