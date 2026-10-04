use crate::{metadata, model::*, operations::TrashProvider};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub(crate) struct Session {
    pub index: Mutex<Index>,
    pub cancel: AtomicBool,
}
impl Session {
    pub(crate) fn with_index<T>(&self, f: impl FnOnce(&mut Index) -> T) -> T {
        // Worker panics are caught at the boundary. Poisoning must not make it
        // impossible to inspect an error or to select a new folder afterwards.
        f(&mut self.index.lock().unwrap_or_else(|p| p.into_inner()))
    }
}
pub struct Engine {
    current: Mutex<Option<Arc<Session>>>,
    sequence: AtomicU64,
    mutation: Mutex<()>,
    journal_directory: PathBuf,
    trash: Arc<dyn TrashProvider>,
}
impl Engine {
    pub fn new(journal_directory: PathBuf) -> Self {
        Self::with_trash(journal_directory, Arc::new(crate::operations::SystemTrash))
    }
    pub fn with_trash(journal_directory: PathBuf, trash: Arc<dyn TrashProvider>) -> Self {
        Self {
            current: Mutex::new(None),
            mutation: Mutex::new(()),
            sequence: AtomicU64::new(1),
            journal_directory,
            trash,
        }
    }
    fn gate(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.mutation
            .lock()
            .map_err(|_| "Состояние операций недоступно. Перезапустите приложение.".to_string())
    }
    pub fn start_scan(&self, root: &Path) -> Result<u64> {
        let _guard = self.gate()?;
        self.start_scan_locked(root, false)
    }
    /// Discard the previous plan only when the replacement scan can start.
    /// A cancelled picker never calls this method; a bad root preserves the plan.
    pub fn choose_scan(&self, root: &Path, discard_plan: bool) -> Result<u64> {
        let _guard = self.gate()?;
        self.start_scan_locked(root, discard_plan)
    }
    fn start_scan_locked(&self, root: &Path, discard_plan: bool) -> Result<u64> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Не удалось открыть состояние приложения.")?;
        if let Some(existing) = &*current {
            existing.with_index(|i| -> Result<()> {
                i.require_idle()?;
                if !discard_plan && (!i.plan.is_empty() || !i.directory_plan.is_empty()) {
                    return Err("Сначала очистите или примените список удаления.".into());
                }
                Ok(())
            })?;
        }
        metadata::validate_root_path(root)?;
        let root = fs::canonicalize(root).map_err(|e| format!("Не удалось открыть папку: {e}"))?;
        let meta = fs::symlink_metadata(&root).map_err(|e| e.to_string())?;
        if !meta.is_dir()
            || metadata::is_link_or_placeholder(&meta)
            || metadata::excluded_directory(&root)
        {
            return Err(
                "Выберите обычную локальную папку, не Корзину и не облачную ссылку.".into(),
            );
        }
        fs::read_dir(&root).map_err(|e| format!("Нет доступа к папке: {e}"))?;
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let session = Arc::new(Session {
            index: Mutex::new(Index::new(
                id,
                root.clone(),
                metadata::identity(&root, &meta),
            )),
            cancel: AtomicBool::new(false),
        });
        spawn(session.clone(), "clearmap-scan", crate::scanner::scan)?;
        *current = Some(session);
        Ok(id)
    }
    pub fn rescan(&self, scan_id: u64) -> Result<u64> {
        self.rescan_with_plan(scan_id, false)
    }
    pub fn rescan_with_plan(&self, scan_id: u64, discard_plan: bool) -> Result<u64> {
        let _guard = self.gate()?;
        let root = self.session(scan_id)?.with_index(|i| -> Result<PathBuf> {
            i.require_idle()?;
            Ok(i.root.clone())
        })?;
        self.start_scan_locked(&root, discard_plan)
    }
    pub(crate) fn session(&self, scan_id: u64) -> Result<Arc<Session>> {
        let guard = self
            .current
            .lock()
            .map_err(|_| "Состояние приложения недоступно.")?;
        let session = guard.as_ref().ok_or("Сначала выберите папку.")?.clone();
        if session.with_index(|i| i.scan_id) != scan_id {
            return Err("Эта карта устарела. Повторите действие в текущей папке.".into());
        }
        Ok(session)
    }
    pub fn status(&self, scan_id: u64) -> Result<Status> {
        Ok(self.session(scan_id)?.with_index(|i| i.status()))
    }
    pub fn current_status(&self) -> Result<Option<Status>> {
        let guard = self
            .current
            .lock()
            .map_err(|_| "Состояние приложения недоступно.")?;
        Ok(guard.as_ref().map(|s| s.with_index(|i| i.status())))
    }
    pub fn query(&self, scan_id: u64, filter: Filter, offset: usize) -> Result<View> {
        self.session(scan_id)?
            .with_index(|i| crate::query::query(i, &filter, offset))
    }
    pub fn cancel(&self, scan_id: u64) -> Result<()> {
        let _guard = self.gate()?;
        let session = self.session(scan_id)?;
        session.cancel.store(true, Ordering::Relaxed);
        Ok(())
    }
    pub fn details(&self, scan_id: u64, id: u64) -> Result<FileDetail> {
        self.session(scan_id)?.with_index(|i| {
            let record = i.record(id)?;
            let duplicates: Vec<_> = i
                .records
                .iter()
                .filter(|r| {
                    !r.removed
                        && r.id != id
                        && record.duplicate_group.is_some()
                        && r.duplicate_group == record.duplicate_group
                })
                .collect();
            Ok(FileDetail {
                file: record.summary(i.now),
                path: i.root.join(&record.relative).to_string_lossy().into_owned(),
                duplicate_count: duplicates.len(),
                duplicates: duplicates
                    .into_iter()
                    .take(50)
                    .map(|r| r.summary(i.now))
                    .collect(),
            })
        })
    }
    pub fn checked_path(
        &self,
        scan_id: u64,
        id: u64,
        allow_executable: bool,
        reveal: bool,
    ) -> Result<PathBuf> {
        let _guard = self.gate()?;
        let (root, identity, record) = self.session(scan_id)?.with_index(|i| -> Result<_> {
            i.require_idle()?;
            Ok((i.root.clone(), i.root_identity, i.record(id)?.clone()))
        })?;
        if !reveal && record.executable && !allow_executable {
            return Err("Для запуска этого файла нужно отдельное подтверждение.".into());
        }
        metadata::validate(&root, identity, &record)
    }
    pub fn checked_directory_path(&self, scan_id: u64, id: u64) -> Result<PathBuf> {
        let _guard = self.gate()?;
        let (root, identity, directory) =
            self.session(scan_id)?.with_index(|index| -> Result<_> {
                index.require_idle()?;
                Ok((
                    index.root.clone(),
                    index.root_identity,
                    index.directory(id)?.clone(),
                ))
            })?;
        metadata::validate_indexed_directory(&root, identity, &directory)
    }
    pub fn find_duplicates(&self, scan_id: u64) -> Result<()> {
        let _guard = self.gate()?;
        let session = self.session(scan_id)?;
        session.with_index(|i| -> Result<()> {
            i.require_idle()?;
            i.phase = Phase::Hashing;
            i.hash_files = 0;
            i.hash_bytes = 0;
            i.hash_candidates = 0;
            i.duplicate_groups = 0;
            i.duplicate_files = 0;
            for r in &mut i.records {
                r.duplicate_group = None;
            }
            i.revision += 1;
            Ok(())
        })?;
        session.cancel.store(false, Ordering::Relaxed);
        spawn(session, "clearmap-duplicates", crate::duplicates::run)
    }
    pub fn add_to_plan(&self, scan_id: u64, ids: Vec<u64>) -> Result<PlanPage> {
        let _guard = self.gate()?;
        if ids.len() > MAX_PLAN {
            return Err("За один раз можно выбрать не более 10 000 файлов.".into());
        }
        self.session(scan_id)?.with_index(|i| {
            i.require_idle()?;
            let ids: std::collections::BTreeSet<_> = ids.into_iter().collect();
            let added = ids
                .iter()
                .filter(|id| {
                    !i.plan.contains(id)
                        && !i.directory_plan.values().any(|p| {
                            i.records
                                .get(**id as usize)
                                .is_some_and(|r| r.relative.starts_with(&p.directory.relative))
                        })
                })
                .count();
            if i.plan_object_count() + added > MAX_PLAN {
                return Err("В плане уже 10 000 файлов. Сначала завершите текущую уборку.".into());
            }
            // Validate the whole request before changing the plan, not a partial prefix.
            for id in &ids {
                let r = i.record(*id)?;
                if r.fingerprint.identity.is_none() || r.fingerprint.modified.is_none() {
                    return Err(format!(
                        "Невозможно безопасно идентифицировать файл {}.",
                        r.name()
                    ));
                }
            }
            for id in ids {
                if !i.directory_plan.values().any(|p| {
                    i.records[id as usize]
                        .relative
                        .starts_with(&p.directory.relative)
                }) {
                    i.plan.insert(id);
                }
            }
            i.plan_revision += 1;
            Ok(plan_page(i, 0))
        })
    }
    pub fn add_directory_to_plan(&self, scan_id: u64, id: u64) -> Result<PlanPage> {
        let _guard = self.gate()?;
        let session = self.session(scan_id)?;
        let (root, identity, plan) = session.with_index(|i| -> Result<_> {
            i.require_idle()?;
            let directory = i.directory(id)?.clone();
            if id == 0 {
                return Err("Операция с корневой папкой запрещена.".into());
            }
            let files = i
                .records
                .iter()
                .filter(|r| !r.removed && r.relative.starts_with(&directory.relative));
            let directories = i
                .directories
                .iter()
                .filter(|d| !d.removed && d.relative.starts_with(&directory.relative));
            if files.clone().count() + directories.clone().count() > MAX_PLAN {
                return Err(
                    "В папке больше 10 000 объектов. Удаляйте её содержимое по частям.".into(),
                );
            }
            Ok((
                i.root.clone(),
                i.root_identity,
                DirectoryPlan {
                    directory: directory.clone(),
                    files: files.cloned().collect(),
                    directories: directories.cloned().collect(),
                },
            ))
        })?;
        // Filesystem work is outside the index lock; the mutation gate prevents a
        // concurrent session change or execution from altering the snapshot.
        metadata::validate_directory_plan(&root, identity, &plan)?;
        session.with_index(|i| {
            if i.directory_plan
                .values()
                .any(|p| plan.directory.relative.starts_with(&p.directory.relative))
            {
                return Ok(plan_page(i, 0));
            }
            let covered = i
                .plan
                .iter()
                .filter(|id| {
                    i.records[**id as usize]
                        .relative
                        .starts_with(&plan.directory.relative)
                })
                .count();
            let child_weight = i
                .directory_plan
                .values()
                .filter(|p| p.directory.relative.starts_with(&plan.directory.relative))
                .map(|p| p.files.len() + p.directories.len())
                .sum::<usize>();
            if i.plan_object_count() - covered - child_weight
                + plan.files.len()
                + plan.directories.len()
                > MAX_PLAN
            {
                return Err("Список удаления заполнен.".into());
            }
            i.plan.retain(|id| {
                !i.records[*id as usize]
                    .relative
                    .starts_with(&plan.directory.relative)
            });
            i.directory_plan
                .retain(|_, p| !p.directory.relative.starts_with(&plan.directory.relative));
            i.directory_plan.insert(id, plan);
            i.plan_revision += 1;
            Ok(plan_page(i, 0))
        })
    }
    pub fn remove_directory_from_plan(&self, scan_id: u64, id: u64) -> Result<PlanPage> {
        let _guard = self.gate()?;
        self.session(scan_id)?.with_index(|i| {
            i.require_idle()?;
            i.directory_plan.remove(&id);
            i.plan_revision += 1;
            Ok(plan_page(i, 0))
        })
    }
    pub fn remove_from_plan(&self, scan_id: u64, ids: Vec<u64>) -> Result<PlanPage> {
        let _guard = self.gate()?;
        if ids.len() > MAX_PLAN {
            return Err("Слишком много идентификаторов.".into());
        }
        self.session(scan_id)?.with_index(|i| {
            i.require_idle()?;
            for id in ids {
                i.plan.remove(&id);
            }
            i.plan_revision += 1;
            Ok(plan_page(i, 0))
        })
    }
    pub fn clear_plan(&self, scan_id: u64) -> Result<()> {
        let _guard = self.gate()?;
        self.session(scan_id)?.with_index(|i| {
            i.require_idle()?;
            i.plan.clear();
            i.directory_plan.clear();
            i.plan_revision += 1;
            Ok(())
        })
    }
    pub fn plan_page(&self, scan_id: u64, offset: usize) -> Result<PlanPage> {
        Ok(self.session(scan_id)?.with_index(|i| plan_page(i, offset)))
    }
    pub fn execute_plan(&self, scan_id: u64, plan_revision: u64) -> Result<()> {
        let _guard = self.gate()?;
        let session = self.session(scan_id)?;
        session.with_index(|i| -> Result<()> {
            i.require_idle()?;
            if i.plan_revision != plan_revision {
                return Err("Список изменился. Проверьте его и подтвердите заново.".into());
            }
            if i.plan.is_empty() && i.directory_plan.is_empty() {
                return Err("Список удаления пуст.".into());
            }
            i.operation = OperationProgress {
                total: i.plan.len() + i.directory_plan.len(),
                ..Default::default()
            };
            i.phase = Phase::Deleting;
            Ok(())
        })?;
        session.cancel.store(false, Ordering::Relaxed);
        let directory = self.journal_directory.clone();
        let trash = self.trash.clone();
        spawn(session, "clearmap-trash", move |session| {
            crate::operations::execute(session, &directory, trash.as_ref())
        })
    }
}
fn plan_page(i: &Index, offset: usize) -> PlanPage {
    let count = i.plan.len() + i.directory_plan.len();
    let offset = offset.min(count.saturating_sub(1) / PAGE_SIZE * PAGE_SIZE);
    let directories = i
        .directory_plan
        .values()
        .skip(offset)
        .take(PAGE_SIZE)
        .map(DirectoryPlan::summary)
        .collect::<Vec<_>>();
    let files = i
        .plan
        .iter()
        .skip(offset.saturating_sub(i.directory_plan.len()))
        .take(PAGE_SIZE - directories.len())
        .filter_map(|id| i.record(*id).ok())
        .map(|r| r.summary(i.now))
        .collect();
    PlanPage {
        revision: i.plan_revision,
        count,
        offset,
        logical_bytes: i.status().plan_bytes,
        files,
        directories,
        directory_count: i.directory_plan.len(),
    }
}

fn spawn(
    session: Arc<Session>,
    name: &str,
    work: impl FnOnce(Arc<Session>) + Send + 'static,
) -> Result<()> {
    let error_session = session.clone();
    std::thread::Builder::new().name(name.into()).spawn(move || {
        let guarded = session.clone();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(guarded))).is_err() {
            session.with_index(|i| {
                i.phase = Phase::Failed; i.revision += 1;
                i.issue(String::new(), "Внутренняя ошибка фоновой задачи. Проверьте Корзину и обновите папку. Незавершённые действия автоматически не повторяются.".into());
            });
        }
    }).map_err(|e| {
        error_session.with_index(|i| i.phase = Phase::Failed);
        format!("Не удалось запустить фоновую задачу: {e}")
    })?;
    Ok(())
}
