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
    let group = v.nodes.iter().find(|n| n.bucket.is_some()).unwrap();
    let child = f
        .engine
        .query(
            id,
            Filter {
                bucket: group.bucket.clone(),
                ..filter
            },
            0,
        )
        .unwrap();
    assert_eq!(child.total, group.count);
    assert_eq!(child.bytes, group.bytes);
    let visible: Vec<u64> = v.nodes.iter().filter_map(|n| n.file_id).collect();
    assert!(child.files.iter().all(|f| !visible.contains(&f.id)));
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
