//! Filesystem integration tests. No test calls the real system Trash.
use clearmap_core::{
    metadata,
    model::{Category, Filter, Metric, Phase, Result, Status, MAP_FILES},
    operations::TrashProvider,
    Engine,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct TestTrash {
    destination: PathBuf,
    fail: bool,
}
impl TrashProvider for TestTrash {
    fn put(&self, path: &Path) -> Result<()> {
        if self.fail {
            return Err("Simulated unavailable Trash".into());
        }
        fs::create_dir_all(&self.destination).map_err(|e| e.to_string())?;
        let target = self.destination.join(path.file_name().unwrap());
        if target.exists() {
            return Err("Test destination exists".into());
        }
        fs::rename(path, target).map_err(|e| e.to_string())
    }
}
struct Fixture {
    temp: TempDir,
    root: PathBuf,
    engine: Engine,
}
impl Fixture {
    fn new(fail: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let engine = Engine::with_trash(
            temp.path().join("journal"),
            Arc::new(TestTrash {
                destination: temp.path().join("test-trash"),
                fail,
            }),
        );
        Self { temp, root, engine }
    }
    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn scan(&self) -> u64 {
        let id = self.engine.start_scan(&self.root).unwrap();
        assert_eq!(wait(&self.engine, id).phase, Phase::Ready);
        id
    }
    fn file_id(&self, id: u64, name: &str) -> u64 {
        self.engine
            .query(
                id,
                Filter {
                    text: name.into(),
                    ..Filter::default()
                },
                0,
            )
            .unwrap()
            .files
            .iter()
            .find(|f| f.name == name)
            .unwrap()
            .id
    }
}
fn wait(engine: &Engine, id: u64) -> Status {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let state = engine.status(id).unwrap();
        if !state.phase.busy() {
            return state;
        }
        assert!(
            Instant::now() < deadline,
            "Background job timed out: {:?}",
            state.phase
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn scans_nested_unicode_and_empty_files() {
    let f = Fixture::new(false);
    f.write("Материалы/Снимок экрана.png", &[1, 2, 3]);
    f.write("empty.txt", &[]);
    let id = f.scan();
    let s = f.engine.status(id).unwrap();
    assert_eq!(s.files, 2);
    assert_eq!(s.logical_bytes, 3);
    let v = f.engine.query(id, Filter::default(), 0).unwrap();
    assert!(v
        .files
        .iter()
        .any(|x| x.screenshot && x.category == Category::Image));
}

#[test]
fn parallel_scan_covers_wide_and_nested_directories() {
    let f = Fixture::new(false);
    for directory in 0..48 {
        for file in 0..4 {
            f.write(
                &format!("branch-{directory}/nested-{file}/file-{file}.bin"),
                &[directory as u8, file as u8],
            );
        }
        fs::create_dir_all(f.root.join(format!("branch-{directory}/empty"))).unwrap();
    }

    let id = f.scan();
    let status = f.engine.status(id).unwrap();
    assert_eq!(status.files, 192);
    assert_eq!(status.logical_bytes, 384);

    let root = f
        .engine
        .query(
            id,
            Filter {
                folders: true,
                ..Filter::default()
            },
            0,
        )
        .unwrap();
    assert_eq!(root.entries.len(), 48);
    assert!(root.entries.iter().all(|entry| entry.count == 4));
}
#[test]
fn classifier_is_case_insensitive_and_flags_launchable_files() {
    assert_eq!(metadata::classify(Path::new("VIDEO.MOV")), Category::Video);
    assert_eq!(
        metadata::classify(Path::new("archive.ZIP")),
        Category::Archive
    );
    assert_eq!(
        metadata::classify(Path::new("launch.desktop")),
        Category::Executable
    );
    assert_eq!(
        metadata::classify(Path::new("danger.PS1")),
        Category::Executable
    );
    assert!(!metadata::screenshot(Path::new("screenshot.txt")));
    assert!(!metadata::screenshot(Path::new("photo.png")));
}
#[test]
fn invalid_root_does_not_destroy_the_current_session() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    assert!(f.engine.start_scan(&f.root.join("missing")).is_err());
    assert_eq!(f.engine.status(id).unwrap().files, 1);
}
#[test]
fn old_session_ids_are_rejected_after_rescan() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    let next = f.engine.rescan(id).unwrap();
    wait(&f.engine, next);
    assert!(f.engine.query(id, Filter::default(), 0).is_err());
    assert!(f.engine.add_to_plan(id, vec![0]).is_err());
}
#[test]
fn plan_does_not_touch_files_and_deduplicates_ids() {
    let f = Fixture::new(false);
    f.write("a.txt", b"important");
    let id = f.scan();
    let p = f.engine.add_to_plan(id, vec![0, 0]).unwrap();
    assert_eq!(p.count, 1);
    assert!(f.root.join("a.txt").exists());
    f.engine.clear_plan(id).unwrap();
    assert!(f.root.join("a.txt").exists());
    assert_eq!(f.engine.plan_page(id, 0).unwrap().count, 0);
}
#[test]
fn invalid_plan_request_is_atomic() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    assert!(f.engine.add_to_plan(id, vec![0, u64::MAX]).is_err());
    assert_eq!(f.engine.plan_page(id, 0).unwrap().count, 0);
}
#[test]
fn changing_folder_requires_clearing_the_plan() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    f.engine.add_to_plan(id, vec![0]).unwrap();
    assert!(f.engine.rescan(id).is_err());
    f.engine.clear_plan(id).unwrap();
    let next = f.engine.rescan(id).unwrap();
    wait(&f.engine, next);
}
#[test]
fn failed_folder_choice_preserves_the_confirmed_plan() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    let plan = f.engine.add_to_plan(id, vec![0]).unwrap();
    assert!(f.engine.choose_scan(&f.root.join("missing"), true).is_err());
    let retained = f.engine.plan_page(id, 0).unwrap();
    assert_eq!(retained.revision, plan.revision);
    assert_eq!(retained.count, 1);
    let next = f.engine.choose_scan(&f.root, true).unwrap();
    assert_eq!(wait(&f.engine, next).plan_count, 0);
    assert!(f.root.join("a.txt").exists());
}
#[test]
fn confirmed_rescan_replaces_the_plan_only_after_validating_the_root() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    let plan = f.engine.add_to_plan(id, vec![0]).unwrap();
    let moved = f.root.with_file_name("moved");
    fs::rename(&f.root, &moved).unwrap();
    assert!(f.engine.rescan_with_plan(id, true).is_err());
    assert_eq!(f.engine.plan_page(id, 0).unwrap().revision, plan.revision);
    fs::rename(&moved, &f.root).unwrap();
    let next = f.engine.rescan_with_plan(id, true).unwrap();
    assert_eq!(wait(&f.engine, next).plan_count, 0);
    assert!(f.root.join("a.txt").exists());
}
#[test]
fn stale_confirmation_cannot_execute() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    f.write("b.txt", b"bb");
    let id = f.scan();
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    f.engine.add_to_plan(id, vec![1]).unwrap();
    assert!(f.engine.execute_plan(id, p.revision).is_err());
    assert_eq!(fs::read_dir(&f.root).unwrap().count(), 2);
}
#[test]
fn changed_file_is_not_trashed() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    f.write("a.txt", b"different length");
    f.engine.execute_plan(id, p.revision).unwrap();
    let s = wait(&f.engine, id);
    assert_eq!(s.operation.failed, 1);
    assert_eq!(s.operation.succeeded, 0);
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(), b"different length");
}
#[test]
fn changed_file_cannot_be_opened_using_an_old_id() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    let id = f.scan();
    f.write("a.txt", b"changed");
    assert!(f.engine.checked_path(id, 0, false, false).is_err());
}
#[test]
fn missing_file_is_reported_without_removing_a_neighbor() {
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    f.write("b.txt", b"bb");
    let id = f.scan();
    let a = f.file_id(id, "a.txt");
    let p = f.engine.add_to_plan(id, vec![a]).unwrap();
    fs::remove_file(f.root.join("a.txt")).unwrap();
    f.engine.execute_plan(id, p.revision).unwrap();
    let s = wait(&f.engine, id);
    assert_eq!(s.operation.failed, 1);
    assert!(f.root.join("b.txt").exists());
}
#[test]
fn trash_error_never_falls_back_to_permanent_deletion() {
    let f = Fixture::new(true);
    f.write("a.txt", b"important");
    let id = f.scan();
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    f.engine.execute_plan(id, p.revision).unwrap();
    let s = wait(&f.engine, id);
    assert_eq!(s.operation.failed, 1);
    assert_eq!(s.plan_count, 1);
    assert!(f.root.join("a.txt").exists());
}
#[test]
fn successful_fake_trash_preserves_content_and_records_a_journal() {
    let f = Fixture::new(false);
    f.write("a.txt", b"important");
    let id = f.scan();
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    f.engine.execute_plan(id, p.revision).unwrap();
    let s = wait(&f.engine, id);
    assert_eq!(s.operation.succeeded, 1);
    assert_eq!(s.files, 0);
    assert_eq!(
        fs::read(f.temp.path().join("test-trash/a.txt")).unwrap(),
        b"important"
    );
    let log = fs::read_dir(f.temp.path().join("journal"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let events: Vec<serde_json::Value> = fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(events[0]["event"], "intent");
    assert_eq!(events[1]["ok"], true);
}
#[test]
fn inaccessible_journal_prevents_any_deletion() {
    let f = Fixture::new(false);
    f.write("a.txt", b"important");
    let id = f.scan();
    fs::write(f.temp.path().join("journal"), b"not a directory").unwrap();
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    f.engine.execute_plan(id, p.revision).unwrap();
    assert_eq!(wait(&f.engine, id).phase, Phase::Failed);
    assert!(f.root.join("a.txt").exists());
}
#[test]
fn full_hash_finds_identical_copies_but_not_just_equal_sizes() {
    let f = Fixture::new(false);
    f.write("a.txt", b"same");
    f.write("b.txt", b"same");
    f.write("c.txt", b"diff");
    let id = f.scan();
    f.engine.find_duplicates(id).unwrap();
    let s = wait(&f.engine, id);
    assert_eq!(s.duplicate_groups, 1);
    assert_eq!(s.duplicate_files, 2);
}
#[test]
fn partial_sample_collision_is_not_a_duplicate() {
    let f = Fixture::new(false);
    let a = vec![0_u8; 512 * 1024];
    let mut b = a.clone();
    b[64 * 1024] = 1;
    f.write("a.bin", &a);
    f.write("b.bin", &b);
    let id = f.scan();
    f.engine.find_duplicates(id).unwrap();
    assert_eq!(wait(&f.engine, id).duplicate_files, 0);
}
#[test]
fn deletion_clears_a_singleton_duplicate_group() {
    let f = Fixture::new(false);
    f.write("a.txt", b"same");
    f.write("b.txt", b"same");
    let id = f.scan();
    f.engine.find_duplicates(id).unwrap();
    wait(&f.engine, id);
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    f.engine.execute_plan(id, p.revision).unwrap();
    assert_eq!(wait(&f.engine, id).duplicate_groups, 0);
}
#[test]
fn executable_open_needs_explicit_confirmation_but_reveal_does_not() {
    let f = Fixture::new(false);
    f.write("example.exe", b"not a real program");
    let id = f.scan();
    assert!(f.engine.checked_path(id, 0, false, false).is_err());
    assert!(f.engine.checked_path(id, 0, true, false).is_ok());
    assert!(f.engine.checked_path(id, 0, false, true).is_ok());
}
#[cfg(windows)]
#[test]
fn windows_script_host_files_require_confirmation_even_in_code_category() {
    let f = Fixture::new(false);
    for extension in ["js", "vbs", "hta", "reg", "cpl", "msc", "wsf"] {
        f.write(&format!("example.{extension}"), b"not executed");
    }
    let id = f.scan();
    for file in f.engine.query(id, Filter::default(), 0).unwrap().files {
        assert!(file.executable);
        assert!(f.engine.checked_path(id, file.id, false, false).is_err());
        assert!(f.engine.checked_path(id, file.id, true, false).is_ok());
        assert!(f.engine.checked_path(id, file.id, false, true).is_ok());
    }
}
#[test]
fn aggregation_is_bounded_and_preserves_totals() {
    let f = Fixture::new(false);
    for n in 0..725 {
        f.write(&format!("file-{n:04}.txt"), b"a");
    }
    let id = f.scan();
    let filter = Filter {
        metric: Metric::Logical,
        ..Filter::default()
    };
    let v = f.engine.query(id, filter.clone(), 0).unwrap();
    assert_eq!(v.files.len(), 200);
    assert!(v.nodes.len() <= MAP_FILES + 96);
    assert_eq!(v.nodes.iter().map(|n| n.count).sum::<usize>(), 725);
    assert_eq!(v.nodes.iter().map(|n| n.bytes).sum::<u64>(), 725);
    let visible: Vec<u64> = v.nodes.iter().filter_map(|n| n.file_id).collect();
    let mut grouped = 0;
    for group in v.nodes.iter().filter(|n| n.bucket.is_some()) {
        let child = f
            .engine
            .query(
                id,
                Filter {
                    bucket: group.bucket.clone(),
                    ..filter.clone()
                },
                0,
            )
            .unwrap();
        assert_eq!(child.total, group.count);
        assert_eq!(child.bytes, group.bytes);
        assert!(child.files.iter().all(|file| !visible.contains(&file.id)));
        grouped += child.total;
    }
    assert_eq!(grouped, 725 - MAP_FILES);
}

#[test]
fn folder_navigation_aggregates_children_and_keeps_ids_after_recount() {
    let f = Fixture::new(false);
    f.write("alpha/a.bin", &[1, 2, 3]);
    f.write("alpha/nested/b.bin", &[4, 5]);
    f.write("root.bin", &[6]);
    let id = f.scan();
    let filter = Filter {
        folders: true,
        metric: Metric::Logical,
        ..Filter::default()
    };
    let root = f.engine.query(id, filter.clone(), 0).unwrap();
    assert_eq!(root.directory_id, 0);
    assert_eq!(root.total, 3);
    assert_eq!(root.bytes, 6);
    assert_eq!(root.entry_total, 2);
    assert_eq!(root.files.len(), 1);
    let alpha = root
        .entries
        .iter()
        .find_map(|entry| entry.directory_id)
        .unwrap();
    let child = f
        .engine
        .query(
            id,
            Filter {
                directory_id: Some(alpha),
                ..filter.clone()
            },
            0,
        )
        .unwrap();
    assert_eq!(child.total, 2);
    assert_eq!(child.bytes, 5);
    assert!(child
        .entries
        .iter()
        .any(|entry| entry.directory_id.is_some()));
    assert_eq!(child.files.len(), 1);
    assert!(f
        .engine
        .query(
            id,
            Filter {
                directory_id: Some(u64::MAX),
                ..filter
            },
            0,
        )
        .is_err());
}

#[test]
fn directory_reveal_path_uses_scan_and_directory_ids() {
    let f = Fixture::new(false);
    f.write("folder/a.txt", b"a");
    let id = f.scan();
    let root = f
        .engine
        .query(
            id,
            Filter {
                folders: true,
                ..Filter::default()
            },
            0,
        )
        .unwrap();
    let directory_id = root
        .entries
        .iter()
        .find_map(|entry| entry.directory_id)
        .unwrap();
    assert_eq!(
        f.engine.checked_directory_path(id, directory_id).unwrap(),
        f.root.join("folder")
    );
    assert!(f.engine.checked_directory_path(id, u64::MAX).is_err());
}

#[test]
fn folder_entries_are_bounded_to_two_hundred() {
    let f = Fixture::new(false);
    for n in 0..250 {
        f.write(&format!("file-{n:03}.txt"), &[1]);
    }
    let id = f.scan();
    let view = f
        .engine
        .query(
            id,
            Filter {
                folders: true,
                metric: Metric::Logical,
                ..Filter::default()
            },
            200,
        )
        .unwrap();
    assert_eq!(view.entry_total, 250);
    assert_eq!(view.entries.len(), 50);
    assert_eq!(view.total, 250);
    assert_eq!(view.bytes, 250);
}

#[test]
fn empty_directories_are_browsable_and_survive_file_removal() {
    let f = Fixture::new(false);
    f.write("empty/only.txt", b"x");
    fs::create_dir_all(f.root.join("never-had-files")).unwrap();
    let id = f.scan();
    let filter = Filter {
        folders: true,
        metric: Metric::Logical,
        ..Filter::default()
    };
    let root = f.engine.query(id, filter.clone(), 0).unwrap();
    let removed_id = root
        .entries
        .iter()
        .find(|entry| entry.name == "empty")
        .and_then(|entry| entry.directory_id)
        .unwrap();
    let empty_id = root
        .entries
        .iter()
        .find(|entry| entry.name == "never-had-files")
        .and_then(|entry| entry.directory_id)
        .unwrap();
    let only_id = f
        .engine
        .query(
            id,
            Filter {
                text: "only.txt".into(),
                ..Filter::default()
            },
            0,
        )
        .unwrap()
        .files[0]
        .id;
    let plan = f.engine.add_to_plan(id, vec![only_id]).unwrap();
    f.engine.execute_plan(id, plan.revision).unwrap();
    wait(&f.engine, id);
    let after = f.engine.query(id, filter, 0).unwrap();
    let removed_dir = after
        .entries
        .iter()
        .find(|entry| entry.name == "empty")
        .unwrap();
    assert_eq!(removed_dir.directory_id, Some(removed_id));
    assert_eq!(removed_dir.bytes, 0);
    assert_eq!(removed_dir.count, 0);
    let empty = after
        .entries
        .iter()
        .find(|entry| entry.directory_id == Some(empty_id))
        .unwrap();
    assert_eq!((empty.bytes, empty.count), (0, 0));
}

#[test]
fn folder_allocated_totals_charge_hard_links_once() {
    let f = Fixture::new(false);
    f.write("same/a.bin", &[7; 8192]);
    fs::hard_link(f.root.join("same/a.bin"), f.root.join("same/b.bin")).unwrap();
    let id = f.scan();
    let view = f
        .engine
        .query(
            id,
            Filter {
                folders: true,
                ..Filter::default()
            },
            0,
        )
        .unwrap();
    let same = view
        .entries
        .iter()
        .find(|entry| entry.name == "same")
        .unwrap();
    let allocated = metadata::allocated(
        &f.root.join("same/a.bin"),
        &fs::metadata(f.root.join("same/a.bin")).unwrap(),
    )
    .unwrap();
    assert_eq!(same.bytes, allocated);
    assert_eq!(same.count, 2);
}
#[test]
fn empty_pages_and_long_search_are_handled() {
    let f = Fixture::new(false);
    let id = f.scan();
    let v = f.engine.query(id, Filter::default(), usize::MAX).unwrap();
    assert_eq!(v.total, 0);
    assert_eq!(v.offset, 0);
    assert!(f
        .engine
        .query(
            id,
            Filter {
                text: "a".repeat(4097),
                ..Filter::default()
            },
            0
        )
        .is_err());
}
#[test]
fn trash_and_system_directories_are_not_scanned() {
    let f = Fixture::new(false);
    f.write(".Trash/secret.txt", b"a");
    f.write("$RECYCLE.BIN/secret.txt", b"b");
    f.write("normal.txt", b"c");
    let id = f.scan();
    assert_eq!(f.engine.status(id).unwrap().files, 1);
}
#[test]
fn mutation_gate_prevents_folder_switch_during_deletion_and_allows_cancel() {
    struct BlockingTrash {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        destination: PathBuf,
    }
    impl TrashProvider for BlockingTrash {
        fn put(&self, path: &Path) -> Result<()> {
            self.started.send(()).map_err(|e| e.to_string())?;
            self.release
                .lock()
                .unwrap()
                .recv()
                .map_err(|e| e.to_string())?;
            fs::rename(path, self.destination.join(path.file_name().unwrap()))
                .map_err(|e| e.to_string())
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("files");
    let dest = temp.path().join("test-trash");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&dest).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join("a.txt"), b"a").unwrap();
    fs::write(root.join("b.txt"), b"b").unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let engine = Engine::with_trash(
        temp.path().join("journal"),
        Arc::new(BlockingTrash {
            started: started_tx,
            release: Mutex::new(release_rx),
            destination: dest,
        }),
    );
    let id = engine.start_scan(&root).unwrap();
    wait(&engine, id);
    let p = engine.add_to_plan(id, vec![0, 1]).unwrap();
    engine.execute_plan(id, p.revision).unwrap();
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(engine.start_scan(&root).is_err());
    assert!(engine.clear_plan(id).is_err());
    engine.cancel(id).unwrap();
    release_tx.send(()).unwrap();
    let s = wait(&engine, id);
    assert_eq!(s.phase, Phase::Cancelled);
    assert_eq!(s.operation.succeeded, 1);
    assert_eq!(s.plan_count, 1);
}
#[cfg(unix)]
#[test]
fn symlinks_and_symlink_loops_are_skipped() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(false);
    f.write("a.txt", b"a");
    symlink(&f.root, f.root.join("loop")).unwrap();
    symlink(f.root.join("a.txt"), f.root.join("link.txt")).unwrap();
    let id = f.scan();
    let s = f.engine.status(id).unwrap();
    assert_eq!(s.files, 1);
    assert_eq!(s.skipped_links, 2);
}
#[test]
fn hard_links_are_counted_once_and_not_duplicates() {
    let f = Fixture::new(false);
    f.write("a.txt", &[3; 8192]);
    fs::hard_link(f.root.join("a.txt"), f.root.join("b.txt")).unwrap();
    let id = f.scan();
    let s = f.engine.status(id).unwrap();
    assert_eq!(s.logical_bytes, 16384);
    assert_eq!(
        s.allocated_bytes,
        metadata::allocated(
            &f.root.join("a.txt"),
            &fs::metadata(f.root.join("a.txt")).unwrap()
        )
        .unwrap()
    );
    f.engine.find_duplicates(id).unwrap();
    assert_eq!(wait(&f.engine, id).duplicate_files, 0);
}
#[cfg(unix)]
#[test]
fn a_root_symlink_and_its_children_are_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(false);
    f.write("sub/a.txt", b"a");
    let link = f.temp.path().canonicalize().unwrap().join("link");
    symlink(&f.root, &link).unwrap();
    assert!(f.engine.start_scan(&link).is_err());
    assert!(f.engine.start_scan(&link.join("sub")).is_err());
}
#[cfg(windows)]
#[test]
fn a_root_junction_and_its_children_are_rejected() {
    // Junction creation does not require symlink privileges or Developer Mode.
    let f = Fixture::new(false);
    f.write("sub/a.txt", b"a");
    let link = f.temp.path().join("junction");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&f.root)
        .output()
        .unwrap();
    assert!(status.status.success());
    assert!(f.engine.start_scan(&link).is_err());
    assert!(f.engine.start_scan(&link.join("sub")).is_err());
    fs::remove_dir(&link).unwrap();
}
#[cfg(unix)]
#[test]
fn sparse_files_keep_logical_and_allocated_sizes_separate() {
    let f = Fixture::new(false);
    fs::File::create(f.root.join("sparse.bin"))
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    let id = f.scan();
    let s = f.engine.status(id).unwrap();
    assert_eq!(s.logical_bytes, 64 * 1024 * 1024);
    let meta = fs::metadata(f.root.join("sparse.bin")).unwrap();
    assert_eq!(
        s.allocated_bytes,
        metadata::allocated(&f.root.join("sparse.bin"), &meta).unwrap()
    );
}
#[cfg(unix)]
#[test]
fn replacing_parent_with_a_symlink_blocks_deletion() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(false);
    f.write("folder/a.txt", b"original");
    let id = f.scan();
    let p = f.engine.add_to_plan(id, vec![0]).unwrap();
    fs::rename(f.root.join("folder"), f.root.join("saved")).unwrap();
    symlink(f.root.join("saved"), f.root.join("folder")).unwrap();
    f.engine.execute_plan(id, p.revision).unwrap();
    assert_eq!(wait(&f.engine, id).operation.failed, 1);
    assert!(f.root.join("saved/a.txt").exists());
}
#[cfg(unix)]
#[test]
fn non_utf8_filenames_keep_native_path_identity() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new(false);
    let name = std::ffi::OsString::from_vec(vec![b'a', 0xff, b'.', b't', b'x', b't']);
    let path = f.root.join(name);
    if let Err(error) = fs::write(&path, b"a") {
        // APFS/HFS+ reject byte sequences that are not valid UTF-8. On those
        // filesystems there is no native path to inspect, so skip this Linux-
        // specific identity check instead of treating the platform limit as
        // an application failure.
        if error.raw_os_error() == Some(92) {
            return;
        }
        panic!("failed to create non-UTF-8 test filename: {error}");
    }
    let id = f.scan();
    assert_eq!(
        f.engine.checked_path(id, 0, false, true).unwrap(),
        path.canonicalize().unwrap()
    );
}

fn directory_id(f: &Fixture, scan: u64, name: &str) -> u64 {
    f.engine
        .query(
            scan,
            Filter {
                folders: true,
                ..Filter::default()
            },
            0,
        )
        .unwrap()
        .entries
        .into_iter()
        .find(|e| e.name == name)
        .unwrap()
        .directory_id
        .unwrap()
}
#[test]
fn directory_plan_moves_the_complete_tree_once_after_revision_confirmation() {
    let f = Fixture::new(false);
    f.write("folder/nested/a.txt", b"original");
    f.write("neighbor.txt", b"keep");
    fs::create_dir_all(f.root.join("folder/empty")).unwrap();
    let scan = f.scan();
    let dir = directory_id(&f, scan, "folder");
    let p = f.engine.add_directory_to_plan(scan, dir).unwrap();
    assert_eq!(p.count, 1);
    assert_eq!(p.directory_count, 1);
    assert_eq!(p.directories[0].file_count, 1);
    assert_eq!(p.logical_bytes, 8);
    assert!(f.root.join("folder/nested/a.txt").exists());
    assert!(f.engine.execute_plan(scan, p.revision - 1).is_err());
    assert!(f.engine.rescan(scan).is_err());
    f.engine.execute_plan(scan, p.revision).unwrap();
    let status = wait(&f.engine, scan);
    assert_eq!(status.operation.succeeded, 1);
    assert_eq!(status.files, 1);
    assert_eq!(status.plan_count, 0);
    assert!(!f.root.join("folder").exists());
    assert!(f.root.join("neighbor.txt").exists());
    assert!(f.temp.path().join("test-trash/folder/empty").is_dir());
    assert_eq!(
        fs::read(f.temp.path().join("test-trash/folder/nested/a.txt")).unwrap(),
        b"original"
    );
    assert!(f.engine.checked_directory_path(scan, dir).is_err());
    assert!(f
        .engine
        .query(
            scan,
            Filter {
                folders: true,
                ..Filter::default()
            },
            0
        )
        .unwrap()
        .entries
        .iter()
        .all(|e| e.name != "folder"));
}
#[test]
fn folder_plan_canonicalizes_parent_child_and_file_overlap() {
    let f = Fixture::new(false);
    f.write("folder/nested/a.txt", b"one");
    f.write("folder/b.txt", b"two");
    let scan = f.scan();
    let dir = directory_id(&f, scan, "folder");
    let child = f
        .engine
        .query(
            scan,
            Filter {
                folders: true,
                directory_id: Some(dir),
                ..Filter::default()
            },
            0,
        )
        .unwrap()
        .entries
        .into_iter()
        .find(|e| e.name == "nested")
        .unwrap()
        .directory_id
        .unwrap();
    let file = f.file_id(scan, "a.txt");
    f.engine.add_to_plan(scan, vec![file]).unwrap();
    let child_plan = f.engine.add_directory_to_plan(scan, child).unwrap();
    assert!(child_plan.files.is_empty());
    assert_eq!(child_plan.count, 1);
    let parent = f.engine.add_directory_to_plan(scan, dir).unwrap();
    assert_eq!(parent.count, 1);
    assert_eq!(parent.logical_bytes, 6);
    assert_eq!(f.engine.add_to_plan(scan, vec![file]).unwrap().count, 1);
    assert_eq!(
        f.engine.add_directory_to_plan(scan, child).unwrap().count,
        1
    );
    assert!(f.engine.execute_plan(scan, parent.revision).is_err());
    let removed = f.engine.remove_directory_from_plan(scan, dir).unwrap();
    assert_eq!(removed.count, 0);
    assert!(f.root.join("folder/nested/a.txt").exists());
}
#[test]
fn root_and_new_or_missing_subtree_entries_cannot_be_planned() {
    for change in ["new-file", "new-empty-dir", "missing-file", "missing-dir"] {
        let f = Fixture::new(false);
        f.write("folder/a.txt", b"one");
        fs::create_dir(f.root.join("folder/empty")).unwrap();
        let scan = f.scan();
        let dir = directory_id(&f, scan, "folder");
        assert!(f.engine.add_directory_to_plan(scan, 0).is_err());
        match change {
            "new-file" => f.write("folder/new.txt", b"new"),
            "new-empty-dir" => fs::create_dir(f.root.join("folder/new")).unwrap(),
            "missing-file" => fs::remove_file(f.root.join("folder/a.txt")).unwrap(),
            _ => fs::remove_dir(f.root.join("folder/empty")).unwrap(),
        }
        assert!(
            f.engine.add_directory_to_plan(scan, dir).is_err(),
            "{change}"
        );
        assert_eq!(f.engine.plan_page(scan, 0).unwrap().count, 0);
    }
}
#[test]
fn post_confirmation_subtree_changes_reject_the_entire_move() {
    for change in [
        "changed-file",
        "new-file",
        "new-dir",
        "missing-file",
        "replaced-dir",
    ] {
        let f = Fixture::new(false);
        f.write("folder/a.txt", b"one");
        fs::create_dir(f.root.join("folder/empty")).unwrap();
        let scan = f.scan();
        let dir = directory_id(&f, scan, "folder");
        let p = f.engine.add_directory_to_plan(scan, dir).unwrap();
        match change {
            "changed-file" => f.write("folder/a.txt", b"different"),
            "new-file" => f.write("folder/new.txt", b"new"),
            "new-dir" => fs::create_dir(f.root.join("folder/new")).unwrap(),
            "missing-file" => fs::remove_file(f.root.join("folder/a.txt")).unwrap(),
            _ => {
                fs::rename(f.root.join("folder/empty"), f.root.join("saved-empty")).unwrap();
                fs::create_dir(f.root.join("folder/empty")).unwrap();
            }
        }
        f.engine.execute_plan(scan, p.revision).unwrap();
        let status = wait(&f.engine, scan);
        assert_eq!(status.operation.failed, 1, "{change}");
        assert_eq!(status.plan_count, 1);
        assert!(f.root.join("folder").is_dir());
        assert!(!f.temp.path().join("test-trash").exists());
    }
}
#[test]
fn empty_folder_deletion_is_explicit_and_trash_failure_preserves_tree() {
    for fail in [false, true] {
        let f = Fixture::new(fail);
        fs::create_dir_all(f.root.join("empty/nested")).unwrap();
        let scan = f.scan();
        let dir = directory_id(&f, scan, "empty");
        let p = f.engine.add_directory_to_plan(scan, dir).unwrap();
        assert_eq!(p.logical_bytes, 0);
        f.engine.execute_plan(scan, p.revision).unwrap();
        let status = wait(&f.engine, scan);
        assert_eq!(status.operation.failed, usize::from(fail));
        assert_eq!(f.root.join("empty/nested").exists(), fail);
        if !fail {
            assert!(f.temp.path().join("test-trash/empty/nested").exists());
        }
    }
}
#[test]
fn directory_reveal_and_deletion_reject_replaced_scanned_directory() {
    let f = Fixture::new(false);
    f.write("folder/a.txt", b"one");
    let scan = f.scan();
    let dir = directory_id(&f, scan, "folder");
    fs::rename(f.root.join("folder"), f.root.join("saved")).unwrap();
    f.write("folder/a.txt", b"one");
    assert!(f.engine.checked_directory_path(scan, dir).is_err());
    assert!(f.engine.add_directory_to_plan(scan, dir).is_err());
}
#[test]
fn excluded_subtrees_prevent_a_whole_directory_move() {
    let f = Fixture::new(false);
    f.write("folder/visible.txt", b"one");
    f.write("folder/.Trash/unindexed.txt", b"keep");
    let scan = f.scan();
    let dir = directory_id(&f, scan, "folder");
    assert!(f.engine.status(scan).unwrap().skipped_special > 0);
    assert!(f.engine.add_directory_to_plan(scan, dir).is_err());
    assert_eq!(f.engine.plan_page(scan, 0).unwrap().count, 0);
}
#[cfg(windows)]
#[test]
fn junction_inside_a_folder_blocks_planning_and_execution() {
    for after_plan in [false, true] {
        let f = Fixture::new(false);
        f.write("folder/visible.txt", b"one");
        f.write("outside/keep.txt", b"keep");
        let scan = f.scan();
        let dir = directory_id(&f, scan, "folder");
        let p = if after_plan {
            Some(f.engine.add_directory_to_plan(scan, dir).unwrap())
        } else {
            None
        };
        let link = f.root.join("folder/link");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(f.root.join("outside"))
            .output()
            .unwrap();
        assert!(output.status.success());
        if let Some(p) = p {
            f.engine.execute_plan(scan, p.revision).unwrap();
            assert_eq!(wait(&f.engine, scan).operation.failed, 1);
        } else {
            assert!(f.engine.add_directory_to_plan(scan, dir).is_err());
        }
        assert!(f.root.join("outside/keep.txt").exists());
        assert!(f.root.join("folder/visible.txt").exists());
        fs::remove_dir(&link).unwrap();
    }
}
#[cfg(unix)]
#[test]
fn skipped_symlinks_prevent_a_whole_directory_move() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(false);
    f.write("folder/a.txt", b"one");
    symlink(&f.root, f.root.join("folder/link")).unwrap();
    let scan = f.scan();
    let dir = directory_id(&f, scan, "folder");
    assert!(f.engine.add_directory_to_plan(scan, dir).is_err());
}

#[test]
fn mixed_folder_file_plan_pages_are_bounded_and_do_not_repeat() {
    let f = Fixture::new(false);
    for n in 0..201 {
        fs::create_dir(f.root.join(format!("folder-{n:03}"))).unwrap();
    }
    f.write("one.txt", b"one");
    f.write("two.txt", b"two");
    let scan = f.scan();
    let filter = Filter {
        folders: true,
        ..Filter::default()
    };
    let dirs = [0, 200]
        .into_iter()
        .flat_map(|offset| {
            f.engine
                .query(scan, filter.clone(), offset)
                .unwrap()
                .entries
        })
        .filter_map(|e| e.directory_id)
        .collect::<Vec<_>>();
    for dir in dirs {
        f.engine.add_directory_to_plan(scan, dir).unwrap();
    }
    f.engine.add_to_plan(scan, vec![0, 1]).unwrap();
    let first = f.engine.plan_page(scan, 0).unwrap();
    let second = f.engine.plan_page(scan, 200).unwrap();
    assert_eq!(first.count, 203);
    assert_eq!(first.directories.len(), 200);
    assert!(first.files.is_empty());
    assert_eq!(second.directories.len(), 1);
    assert_eq!(second.files.len(), 2);
    assert!(first
        .directories
        .iter()
        .all(|a| second.directories.iter().all(|b| a.id != b.id)));
    assert_eq!(f.engine.plan_page(scan, usize::MAX).unwrap().offset, 200);
    f.engine.clear_plan(scan).unwrap();
    assert_eq!(f.engine.status(scan).unwrap().plan_count, 0);
}
