use crate::metadata::{Fingerprint, Identity};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_PLAN: usize = 10_000;
pub const MAX_ISSUES: usize = 100;
pub const PAGE_SIZE: usize = 200;
pub const MAP_FILES: usize = 480;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Video,
    Image,
    Audio,
    Document,
    Archive,
    Code,
    Executable,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Metric {
    Logical,
    #[default]
    Allocated,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Scanning,
    Ready,
    Cancelled,
    Hashing,
    Deleting,
    Failed,
}
impl Phase {
    pub fn busy(self) -> bool {
        matches!(self, Self::Scanning | Self::Hashing | Self::Deleting)
    }
}

#[derive(Debug, Clone)]
pub struct Record {
    pub id: u64,
    pub relative: PathBuf,
    pub category: Category,
    pub screenshot: bool,
    pub fingerprint: Fingerprint,
    pub allocated: Option<u64>,
    pub allocated_charge: u64,
    pub hard_link: bool,
    pub executable: bool,
    pub duplicate_group: Option<u64>,
    pub removed: bool,
}
impl Record {
    pub fn size(&self, metric: Metric) -> u64 {
        match metric {
            Metric::Logical => self.fingerprint.len,
            Metric::Allocated => self.allocated_charge,
        }
    }
    pub fn name(&self) -> String {
        self.relative
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }
    pub fn summary(&self, now: u64) -> FileSummary {
        FileSummary {
            id: self.id,
            name: self.name(),
            relative_path: self.relative.to_string_lossy().into_owned(),
            category: self.category,
            logical_bytes: self.fingerprint.len,
            allocated_bytes: self.allocated,
            charged_bytes: self.allocated_charge,
            modified_ms: self.fingerprint.modified.map(time_ms),
            age_bucket: age_bucket(self.fingerprint.modified.map(time_ms), now),
            screenshot: self.screenshot,
            hard_link: self.hard_link,
            executable: self.executable,
            duplicate_group: self.duplicate_group,
            actionable: self.fingerprint.identity.is_some() && self.fingerprint.modified.is_some(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub id: u64,
    pub name: String,
    pub relative_path: String,
    pub category: Category,
    pub logical_bytes: u64,
    pub allocated_bytes: Option<u64>,
    pub charged_bytes: u64,
    pub modified_ms: Option<u64>,
    pub age_bucket: u8,
    pub screenshot: bool,
    pub hard_link: bool,
    pub executable: bool,
    pub duplicate_group: Option<u64>,
    pub actionable: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDetail {
    pub file: FileSummary,
    pub path: String,
    pub duplicates: Vec<FileSummary>,
    pub duplicate_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub bytes: u64,
    pub id: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub category: Category,
    pub age: u8,
    pub screenshot: bool,
    pub after: Cursor,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub text: String,
    pub category: Option<Category>,
    pub min_bytes: u64,
    pub older_days: Option<u32>,
    pub duplicates_only: bool,
    pub screenshots_only: bool,
    pub metric: Metric,
    pub bucket: Option<Bucket>,
    pub duplicate_group: Option<u64>,
    pub folders: bool,
    pub directory_id: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    pub key: String,
    pub label: String,
    pub bytes: u64,
    pub count: usize,
    pub category: Category,
    pub age_bucket: u8,
    pub file_id: Option<u64>,
    pub duplicate_group: Option<u64>,
    pub screenshot: bool,
    pub bucket: Option<Bucket>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotal {
    pub category: Category,
    pub bytes: u64,
    pub count: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCrumb {
    pub id: u64,
    pub name: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub directory_id: Option<u64>,
    pub file: Option<FileSummary>,
    pub name: String,
    pub bytes: u64,
    pub count: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub scan_id: u64,
    pub revision: u64,
    pub total: usize,
    pub bytes: u64,
    pub offset: usize,
    pub files: Vec<FileSummary>,
    pub nodes: Vec<MapNode>,
    pub categories: Vec<CategoryTotal>,
    pub directory_id: u64,
    pub breadcrumbs: Vec<DirectoryCrumb>,
    pub entries: Vec<DirectoryEntry>,
    pub entry_total: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub path: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub total: usize,
    pub completed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub errors: Vec<Issue>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub scan_id: u64,
    pub revision: u64,
    pub root: String,
    pub phase: Phase,
    pub files: usize,
    pub logical_bytes: u64,
    pub allocated_bytes: u64,
    pub approximate_count: usize,
    pub skipped_links: usize,
    pub skipped_special: usize,
    pub issues_count: usize,
    pub issues: Vec<Issue>,
    pub elapsed_ms: u64,
    pub current_path: String,
    pub hash_bytes: u64,
    pub hash_files: usize,
    pub hash_candidates: usize,
    pub duplicate_groups: usize,
    pub duplicate_files: usize,
    pub plan_count: usize,
    pub plan_bytes: u64,
    pub plan_revision: u64,
    pub operation: OperationProgress,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPage {
    pub revision: u64,
    pub count: usize,
    pub logical_bytes: u64,
    pub offset: usize,
    pub files: Vec<FileSummary>,
}

#[derive(Debug, Clone)]
pub struct Directory {
    pub id: u64,
    pub relative: PathBuf,
    pub parent: Option<u64>,
    pub name: String,
}

pub struct Index {
    pub scan_id: u64,
    pub root: PathBuf,
    pub root_identity: Option<Identity>,
    pub records: Vec<Record>,
    pub phase: Phase,
    pub revision: u64,
    pub started: Instant,
    pub elapsed_ms: u64,
    pub now: u64,
    pub logical_bytes: u64,
    pub allocated_bytes: u64,
    pub approximate_count: usize,
    pub live_count: usize,
    pub skipped_links: usize,
    pub skipped_special: usize,
    pub issues_count: usize,
    pub issues: Vec<Issue>,
    pub current_path: String,
    pub seen: HashSet<Identity>,
    pub plan: BTreeSet<u64>,
    pub plan_revision: u64,
    pub hash_bytes: u64,
    pub hash_files: usize,
    pub hash_candidates: usize,
    pub duplicate_groups: usize,
    pub duplicate_files: usize,
    pub operation: OperationProgress,
    pub directories: Vec<Directory>,
    pub directory_ids: HashMap<PathBuf, u64>,
}
impl Index {
    pub fn new(scan_id: u64, root: PathBuf, root_identity: Option<Identity>) -> Self {
        Self {
            scan_id,
            root,
            root_identity,
            records: Vec::new(),
            phase: Phase::Scanning,
            revision: 0,
            started: Instant::now(),
            elapsed_ms: 0,
            now: time_ms(SystemTime::now()),
            logical_bytes: 0,
            allocated_bytes: 0,
            approximate_count: 0,
            live_count: 0,
            skipped_links: 0,
            skipped_special: 0,
            issues_count: 0,
            issues: Vec::new(),
            current_path: String::new(),
            seen: HashSet::new(),
            plan: BTreeSet::new(),
            plan_revision: 0,
            hash_bytes: 0,
            hash_files: 0,
            hash_candidates: 0,
            duplicate_groups: 0,
            duplicate_files: 0,
            operation: OperationProgress::default(),
            directories: vec![Directory {
                id: 0,
                relative: PathBuf::new(),
                parent: None,
                name: String::new(),
            }],
            directory_ids: HashMap::from([(PathBuf::new(), 0)]),
        }
    }
    pub fn push(&mut self, mut record: Record) {
        record.id = self.records.len() as u64;
        record.allocated_charge = if record
            .fingerprint
            .identity
            .is_some_and(|id| !self.seen.insert(id))
        {
            record.hard_link = true;
            0
        } else {
            record.allocated.unwrap_or(record.fingerprint.len)
        };
        self.logical_bytes = self.logical_bytes.saturating_add(record.fingerprint.len);
        self.allocated_bytes = self.allocated_bytes.saturating_add(record.allocated_charge);
        self.approximate_count += usize::from(record.allocated.is_none());
        self.live_count += 1;
        if let Some(parent) = record.relative.parent() {
            self.register_directory(parent);
        }
        self.records.push(record);
    }
    pub(crate) fn register_directory(&mut self, relative: &std::path::Path) {
        let mut directory = relative;
        let mut ancestors = Vec::new();
        while !directory.as_os_str().is_empty() {
            ancestors.push(directory.to_path_buf());
            directory = directory
                .parent()
                .unwrap_or_else(|| std::path::Path::new(""));
        }
        for path in ancestors.into_iter().rev() {
            if self.directory_ids.contains_key(&path) {
                continue;
            }
            let parent_path = path.parent().unwrap_or_else(|| std::path::Path::new(""));
            let parent = *self.directory_ids.get(parent_path).unwrap_or(&0);
            let id = self.directories.len() as u64;
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            self.directory_ids.insert(path.clone(), id);
            self.directories.push(Directory {
                id,
                relative: path,
                parent: Some(parent),
                name,
            });
        }
    }
    pub fn directory(&self, id: u64) -> Result<&Directory> {
        self.directories
            .get(usize::try_from(id).unwrap_or(usize::MAX))
            .filter(|directory| directory.id == id)
            .ok_or_else(|| "Некорректный идентификатор каталога. Обновите папку.".into())
    }
    pub fn breadcrumbs(&self, id: u64) -> Result<Vec<DirectoryCrumb>> {
        let mut result = Vec::new();
        let mut current = Some(id);
        while let Some(directory_id) = current {
            let directory = self.directory(directory_id)?;
            result.push(DirectoryCrumb {
                id: directory.id,
                name: if directory.parent.is_none() {
                    self.root
                        .file_name()
                        .unwrap_or_else(|| self.root.as_os_str())
                        .to_string_lossy()
                        .into_owned()
                } else {
                    directory.name.clone()
                },
            });
            current = directory.parent;
        }
        result.reverse();
        Ok(result)
    }
    pub fn recount(&mut self) {
        self.seen.clear();
        self.live_count = 0;
        self.logical_bytes = 0;
        self.allocated_bytes = 0;
        self.approximate_count = 0;
        for record in self.records.iter_mut().filter(|r| !r.removed) {
            record.allocated_charge = if record
                .fingerprint
                .identity
                .is_some_and(|id| !self.seen.insert(id))
            {
                0
            } else {
                record.allocated.unwrap_or(record.fingerprint.len)
            };
            self.live_count += 1;
            self.logical_bytes = self.logical_bytes.saturating_add(record.fingerprint.len);
            self.allocated_bytes = self.allocated_bytes.saturating_add(record.allocated_charge);
            self.approximate_count += usize::from(record.allocated.is_none());
        }
        // A singleton is no longer a duplicate after the other copy has been removed.
        let mut groups = std::collections::HashMap::<u64, usize>::new();
        for r in self.records.iter().filter(|r| !r.removed) {
            if let Some(g) = r.duplicate_group {
                *groups.entry(g).or_default() += 1;
            }
        }
        for r in &mut self.records {
            if r.duplicate_group
                .is_some_and(|g| groups.get(&g).copied().unwrap_or(0) < 2)
            {
                r.duplicate_group = None;
            }
        }
        self.duplicate_groups = groups.values().filter(|&&count| count > 1).count();
        self.duplicate_files = groups.values().filter(|&&count| count > 1).sum();
        self.revision += 1;
    }
    pub fn record(&self, id: u64) -> Result<&Record> {
        let position =
            usize::try_from(id).map_err(|_| "Некорректный идентификатор файла".to_string())?;
        self.records
            .get(position)
            .filter(|r| !r.removed)
            .ok_or_else(|| "Файл больше не входит в эту карту. Обновите папку.".into())
    }
    pub fn issue(&mut self, path: String, message: String) {
        self.issues_count += 1;
        if self.issues.len() < MAX_ISSUES {
            self.issues.push(Issue { path, message });
        }
    }
    pub fn status(&self) -> Status {
        let plan_bytes = self
            .plan
            .iter()
            .filter_map(|id| self.record(*id).ok())
            .fold(0u64, |n, r| n.saturating_add(r.fingerprint.len));
        Status {
            scan_id: self.scan_id,
            revision: self.revision,
            root: self.root.to_string_lossy().into_owned(),
            phase: self.phase,
            files: self.live_count,
            logical_bytes: self.logical_bytes,
            allocated_bytes: self.allocated_bytes,
            approximate_count: self.approximate_count,
            skipped_links: self.skipped_links,
            skipped_special: self.skipped_special,
            issues_count: self.issues_count,
            issues: self.issues.clone(),
            elapsed_ms: if self.phase == Phase::Scanning {
                self.started.elapsed().as_millis() as u64
            } else {
                self.elapsed_ms
            },
            current_path: self.current_path.clone(),
            hash_bytes: self.hash_bytes,
            hash_files: self.hash_files,
            hash_candidates: self.hash_candidates,
            duplicate_groups: self.duplicate_groups,
            duplicate_files: self.duplicate_files,
            plan_count: self.plan.len(),
            plan_bytes,
            plan_revision: self.plan_revision,
            operation: self.operation.clone(),
        }
    }
    pub fn require_idle(&self) -> Result<()> {
        if self.phase.busy() {
            Err("Дождитесь завершения текущей операции или остановите её.".into())
        } else {
            Ok(())
        }
    }
}
pub fn time_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|t| t.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
pub fn age_bucket(modified_ms: Option<u64>, now: u64) -> u8 {
    let Some(modified) = modified_ms else {
        return 5;
    };
    match now.saturating_sub(modified) / 86_400_000 {
        0..=6 => 0,
        7..=29 => 1,
        30..=89 => 2,
        90..=364 => 3,
        _ => 4,
    }
}
