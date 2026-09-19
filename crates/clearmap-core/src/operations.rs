use crate::{
    engine::Session,
    metadata,
    model::{time_ms, Issue, Phase, Result, MAX_ISSUES},
};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::SystemTime,
};

pub trait TrashProvider: Send + Sync {
    fn put(&self, path: &Path) -> Result<()>;
}
pub struct SystemTrash;
impl TrashProvider for SystemTrash {
    fn put(&self, path: &Path) -> Result<()> {
        // Never fall back to remove_file/remove_dir_all or a shell command.
        #[cfg(windows)]
        {
            crate::trash_windows::put(path)
        }
        #[cfg(target_os = "linux")]
        {
            use gio::prelude::FileExt;
            // GIO has a trash-only API. Avoid trash-rs' documented non-threadsafe
            // mount-point enumeration in a process also running GTK/WebKit.
            gio::File::for_path(path)
                .trash(None::<&gio::Cancellable>)
                .map_err(|e| format!("Не удалось переместить в системную Корзину: {e}"))
        }
        #[cfg(target_os = "macos")]
        {
            trash::delete(path)
                .map_err(|e| format!("Не удалось переместить в системную Корзину: {e}"))
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = path;
            Err("Системная Корзина на этой платформе не поддерживается.".into())
        }
    }
}
fn journal(file: &mut File, event: serde_json::Value) -> Result<()> {
    serde_json::to_writer(&mut *file, &event)
        .map_err(|e| format!("Не удалось записать журнал: {e}"))?;
    file.write_all(b"\n")
        .and_then(|()| file.sync_data())
        .map_err(|e| format!("Не удалось сохранить журнал: {e}"))
}
pub(crate) fn execute(session: Arc<Session>, directory: &Path, trash: &dyn TrashProvider) {
    let (root, identity, ids, scan_id) = session.with_index(|i| {
        (
            i.root.clone(),
            i.root_identity,
            i.plan.iter().copied().collect::<Vec<_>>(),
            i.scan_id,
        )
    });
    let log = fs::create_dir_all(directory).and_then(|()| {
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(directory.join(format!(
                "cleanup-{}-{scan_id}.jsonl",
                time_ms(SystemTime::now())
            )))
    });
    let mut log = match log {
        Ok(file) => file,
        Err(error) => {
            session.with_index(|i| {
                i.phase = Phase::Failed;
                i.issue(
                    directory.to_string_lossy().into_owned(),
                    format!("Удаление не начато: журнал недоступен. {error}"),
                );
            });
            return;
        }
    };
    for id in ids {
        if session.cancel.load(Ordering::Relaxed) {
            break;
        }
        let record = session.with_index(|i| i.record(id).cloned());
        let result = record.and_then(|record| {
            let path = metadata::validate(&root, identity, &record)?;
            journal(&mut log, serde_json::json!({"event":"intent", "scanId":scan_id, "id":id, "path":path.to_string_lossy(), "bytes":record.fingerprint.len, "time":time_ms(SystemTime::now())}))?;
            // The flush may take time; check again immediately before calling the OS.
            metadata::validate(&root, identity, &record)?;
            trash.put(&path)
        });
        let result_for_log = match &result {
            Ok(()) => "trashed".to_string(),
            Err(error) => error.clone(),
        };
        let journal_result = journal(
            &mut log,
            serde_json::json!({"event":"result", "scanId":scan_id, "id":id, "ok":result.is_ok(), "result":result_for_log, "time":time_ms(SystemTime::now())}),
        );
        session.with_index(|i| {
            i.operation.completed += 1;
            match result {
                Ok(()) => {
                    if let Some(record) = i.records.get_mut(id as usize) {
                        record.removed = true;
                    }
                    i.plan.remove(&id);
                    i.plan_revision += 1;
                    i.operation.succeeded += 1;
                }
                Err(message) => {
                    i.operation.failed += 1;
                    let path = i
                        .record(id)
                        .map(|r| r.relative.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if i.operation.errors.len() < MAX_ISSUES {
                        i.operation.errors.push(Issue { path, message });
                    }
                }
            }
            i.revision += 1;
        });
        if let Err(error) = journal_result {
            session.with_index(|i| i.issue(directory.to_string_lossy().into_owned(), error));
            session.cancel.store(true, Ordering::Relaxed);
            break;
        }
    }
    session.with_index(|i| {
        i.recount();
        i.current_path.clear();
        i.phase = if session.cancel.load(Ordering::Relaxed) {
            Phase::Cancelled
        } else {
            Phase::Ready
        };
    });
}
