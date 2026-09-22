use crate::{
    engine::Session,
    metadata,
    model::{Phase, Record},
};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::Ordering,
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const BATCH_SIZE: usize = 256;
const CHANNEL_CAPACITY: usize = 1_024;
const MAX_WORKERS: usize = 8;

enum ScanItem {
    File(Record),
    Directory(PathBuf),
    Issue(PathBuf, String),
    SkippedLink,
    SkippedSpecial,
}

struct DirectoryWork {
    path: PathBuf,
    depth: usize,
}

struct QueueState {
    directories: VecDeque<DirectoryWork>,
    pending: usize,
    stopped: bool,
}

struct WorkQueue {
    state: Mutex<QueueState>,
    ready: Condvar,
}

impl WorkQueue {
    fn new(root: PathBuf) -> Self {
        Self {
            state: Mutex::new(QueueState {
                directories: VecDeque::from([DirectoryWork {
                    path: root,
                    depth: 0,
                }]),
                pending: 1,
                stopped: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn next(&self, session: &Session) -> Option<DirectoryWork> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if session.cancel.load(Ordering::Relaxed) {
                state.stopped = true;
                state.directories.clear();
                self.ready.notify_all();
                return None;
            }
            if state.stopped {
                return None;
            }
            if let Some(work) = state.directories.pop_front() {
                return Some(work);
            }
            state = self
                .ready
                .wait_timeout(state, Duration::from_millis(20))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    fn add(&self, work: DirectoryWork) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.stopped {
            return;
        }
        state.pending += 1;
        state.directories.push_back(work);
        self.ready.notify_one();
    }

    fn complete(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.stopped {
            return;
        }
        state.pending = state.pending.saturating_sub(1);
        if state.pending == 0 {
            state.stopped = true;
            self.ready.notify_all();
        }
    }
}

pub(crate) fn scan(session: Arc<Session>) {
    let (root, root_identity) =
        session.with_index(|index| (index.root.clone(), index.root_identity));
    let queue = Arc::new(WorkQueue::new(root.clone()));
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, MAX_WORKERS);
    let (sender, receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    let mut directory_batch = Vec::with_capacity(BATCH_SIZE);
    let mut last_flush = Instant::now();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let sender = sender.clone();
            let queue = queue.clone();
            let session = session.clone();
            let root = &root;
            scope.spawn(move || worker(&session, root, root_identity, &queue, &sender));
        }
        drop(sender);

        for item in receiver {
            match item {
                ScanItem::File(record) => batch.push(record),
                ScanItem::Directory(directory) => directory_batch.push(directory),
                ScanItem::Issue(path, message) => session
                    .with_index(|index| index.issue(path.to_string_lossy().into_owned(), message)),
                ScanItem::SkippedLink => session.with_index(|index| index.skipped_links += 1),
                ScanItem::SkippedSpecial => session.with_index(|index| index.skipped_special += 1),
            }
            if batch.len() >= BATCH_SIZE
                || directory_batch.len() >= BATCH_SIZE
                || last_flush.elapsed() >= Duration::from_millis(120)
            {
                flush(&session, &mut batch, &mut directory_batch);
                last_flush = Instant::now();
            }
        }
    });

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

fn worker(
    session: &Session,
    root: &Path,
    root_identity: Option<metadata::Identity>,
    queue: &WorkQueue,
    sender: &SyncSender<ScanItem>,
) {
    while let Some(work) = queue.next(session) {
        scan_directory(session, root, root_identity, queue, sender, &work);
        queue.complete();
    }
}

fn scan_directory(
    session: &Session,
    root: &Path,
    root_identity: Option<metadata::Identity>,
    queue: &WorkQueue,
    sender: &SyncSender<ScanItem>,
    work: &DirectoryWork,
) {
    let entries = match fs::read_dir(&work.path) {
        Ok(entries) => entries,
        Err(error) => {
            send(
                sender,
                ScanItem::Issue(work.path.clone(), format!("Не удалось прочитать: {error}")),
            );
            return;
        }
    };

    for entry in entries {
        if session.cancel.load(Ordering::Relaxed) {
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                send(
                    sender,
                    ScanItem::Issue(work.path.clone(), format!("Не удалось прочитать: {error}")),
                );
                continue;
            }
        };
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) => {
                send(
                    sender,
                    ScanItem::Issue(path, format!("Метаданные недоступны: {error}")),
                );
                continue;
            }
        };
        if metadata::is_link_or_placeholder(&meta) {
            send(sender, ScanItem::SkippedLink);
            continue;
        }
        if meta.is_dir() {
            if metadata::excluded_directory(&path)
                || work.depth >= 511
                || !metadata::same_file_system(root_identity, &path, &meta)
            {
                send(sender, ScanItem::SkippedSpecial);
                continue;
            }
            if let Ok(relative) = path.strip_prefix(root) {
                send(sender, ScanItem::Directory(relative.to_path_buf()));
            }
            queue.add(DirectoryWork {
                path,
                depth: work.depth + 1,
            });
            continue;
        }
        if !meta.is_file() {
            send(sender, ScanItem::SkippedSpecial);
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let category = metadata::classify(&path);
        send(
            sender,
            ScanItem::File(Record {
                id: 0,
                relative: relative.to_path_buf(),
                category,
                screenshot: metadata::screenshot_in_category(&path, category),
                fingerprint: metadata::Fingerprint::capture(&path, &meta),
                allocated: metadata::allocated(&path, &meta),
                allocated_charge: 0,
                hard_link: metadata::hard_link(&meta),
                executable: metadata::executable_in_category(&path, &meta, category),
                duplicate_group: None,
                removed: false,
            }),
        );
    }
}

fn send(sender: &SyncSender<ScanItem>, item: ScanItem) {
    let _ = sender.send(item);
}

fn flush(session: &Session, batch: &mut Vec<Record>, directory_batch: &mut Vec<PathBuf>) {
    if batch.is_empty() && directory_batch.is_empty() {
        return;
    }
    session.with_index(|index| {
        index.current_path = batch
            .last()
            .map(|record| record.relative.to_string_lossy().into_owned())
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
