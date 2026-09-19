use crate::{
    engine::Session,
    metadata::{self, Fingerprint},
    model::{Phase, Record, Result},
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::{atomic::Ordering, Arc},
};
const CHUNK: usize = 256 * 1024;
const SAMPLE: usize = 16 * 1024;

pub(crate) fn run(session: Arc<Session>) {
    let (root, root_identity, candidates) = session.with_index(|index| {
        let mut by_size = BTreeMap::<u64, Vec<u64>>::new();
        let mut seen = HashSet::new();
        for r in index
            .records
            .iter()
            .filter(|r| !r.removed && r.fingerprint.len > 0)
        {
            // Hard links are one file, not independent duplicate copies.
            let Some(identity) = r.fingerprint.identity else {
                continue;
            };
            if !seen.insert(identity) {
                continue;
            }
            by_size.entry(r.fingerprint.len).or_default().push(r.id);
        }
        by_size.retain(|_, rows| rows.len() > 1);
        index.hash_candidates = by_size.values().map(Vec::len).sum();
        (index.root.clone(), index.root_identity, by_size)
    });
    let mut next_group = 1u64;
    for ids in candidates.into_values() {
        // Clone paths only for the current same-size candidate group, not the full index.
        let records: Vec<Record> = session.with_index(|i| {
            ids.iter()
                .filter_map(|id| i.record(*id).ok().cloned())
                .collect()
        });
        if cancelled(&session) {
            break;
        }
        let mut samples = HashMap::<[u8; 32], Vec<Record>>::new();
        for record in records {
            if cancelled(&session) {
                break;
            }
            match fingerprint(&session, &root, root_identity, &record, true) {
                Ok(hash) => {
                    samples.entry(hash).or_default().push(record);
                }
                Err(error) => report(&session, &record, error),
            }
            session.with_index(|i| i.hash_files += 1);
        }
        for group in samples.into_values().filter(|group| group.len() > 1) {
            if cancelled(&session) {
                break;
            }
            let mut hashes = BTreeMap::<[u8; 32], Vec<Record>>::new();
            for record in group {
                if cancelled(&session) {
                    break;
                }
                match fingerprint(&session, &root, root_identity, &record, false) {
                    Ok(hash) => {
                        hashes.entry(hash).or_default().push(record);
                    }
                    Err(error) => report(&session, &record, error),
                }
            }
            for equal in hashes.into_values().filter(|equal| equal.len() > 1) {
                // Recheck all candidates again before publishing a complete-hash match.
                let valid: Vec<_> = equal
                    .into_iter()
                    .filter(|r| metadata::validate(&root, root_identity, r).is_ok())
                    .collect();
                if valid.len() < 2 {
                    continue;
                }
                session.with_index(|i| {
                    for r in &valid {
                        i.records[r.id as usize].duplicate_group = Some(next_group);
                    }
                    i.duplicate_groups += 1;
                    i.duplicate_files += valid.len();
                    i.revision += 1;
                });
                next_group += 1;
            }
        }
    }
    session.with_index(|i| {
        i.phase = if cancelled(&session) {
            Phase::Cancelled
        } else {
            Phase::Ready
        };
        i.current_path.clear();
        i.revision += 1;
    });
}
fn cancelled(session: &Session) -> bool {
    session.cancel.load(Ordering::Relaxed)
}
fn report(session: &Session, record: &Record, message: String) {
    if !cancelled(session) {
        session.with_index(|i| i.issue(record.relative.to_string_lossy().into_owned(), message));
    }
}
fn fingerprint(
    session: &Session,
    root: &std::path::Path,
    root_id: Option<metadata::Identity>,
    record: &Record,
    sampled: bool,
) -> Result<[u8; 32]> {
    let path = metadata::validate(root, root_id, record)?;
    let mut file = File::open(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if Fingerprint::capture(&path, &before) != record.fingerprint {
        return Err("Файл изменился до чтения.".into());
    }
    session.with_index(|i| i.current_path = record.relative.to_string_lossy().into_owned());
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; if sampled { SAMPLE } else { CHUNK }];
    if sampled {
        let len = record.fingerprint.len;
        for offset in [
            0,
            len.saturating_sub(SAMPLE as u64) / 2,
            len.saturating_sub(SAMPLE as u64),
        ] {
            if cancelled(session) {
                return Err("Остановлено".into());
            }
            file.seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let n = ((len - offset).min(SAMPLE as u64)) as usize;
            file.read_exact(&mut buffer[..n])
                .map_err(|e| e.to_string())?;
            hasher.update(&offset.to_le_bytes());
            hasher.update(&buffer[..n]);
            session.with_index(|i| i.hash_bytes = i.hash_bytes.saturating_add(n as u64));
        }
    } else {
        let mut read_bytes = 0u64;
        loop {
            if cancelled(session) {
                return Err("Остановлено".into());
            }
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            read_bytes += n as u64;
            // Bound the read if another program continuously appends data.
            if read_bytes > record.fingerprint.len {
                return Err("Файл вырос во время проверки.".into());
            }
            session.with_index(|i| i.hash_bytes = i.hash_bytes.saturating_add(n as u64));
        }
        if read_bytes != record.fingerprint.len {
            return Err("Размер файла изменился во время проверки.".into());
        }
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    if Fingerprint::capture(&path, &after) != record.fingerprint {
        return Err("Файл изменился во время проверки.".into());
    }
    metadata::validate(root, root_id, record)?;
    Ok(*hasher.finalize().as_bytes())
}
