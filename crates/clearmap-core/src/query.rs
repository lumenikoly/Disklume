use crate::model::*;
use std::collections::BTreeMap;

pub fn query(index: &Index, filter: &Filter, offset: usize) -> Result<View> {
    if filter.text.len() > 4096 {
        return Err("Поисковый запрос слишком длинный.".into());
    }
    if filter.folders {
        return folder_query(index, filter, offset);
    }
    let needle = filter.text.to_lowercase();
    let mut records: Vec<&Record> = index
        .records
        .iter()
        .filter(|r| !r.removed)
        .filter(|r| {
            let size = r.size(filter.metric);
            let age = age_bucket(r.fingerprint.modified.map(time_ms), index.now);
            if filter.category.is_some_and(|c| r.category != c) || size < filter.min_bytes {
                return false;
            }
            if filter.duplicates_only && r.duplicate_group.is_none() {
                return false;
            }
            if filter
                .duplicate_group
                .is_some_and(|g| r.duplicate_group != Some(g))
            {
                return false;
            }
            if filter.screenshots_only && !r.screenshot {
                return false;
            }
            if let Some(days) = filter.older_days {
                let Some(modified) = r.fingerprint.modified.map(time_ms) else {
                    return false;
                };
                if index.now.saturating_sub(modified) < days as u64 * 86_400_000 {
                    return false;
                }
            }
            if let Some(b) = &filter.bucket {
                if r.category != b.category || age != b.age || r.screenshot != b.screenshot {
                    return false;
                }
                if size > b.after.bytes || (size == b.after.bytes && r.id <= b.after.id) {
                    return false;
                }
                if size < b.through.bytes || (size == b.through.bytes && r.id > b.through.id) {
                    return false;
                }
            }
            needle.is_empty()
                || r.relative
                    .to_string_lossy()
                    .to_lowercase()
                    .contains(&needle)
        })
        .collect();
    // Sort only lightweight references; paths and records stay in the Rust index.
    records.sort_unstable_by(|a, b| {
        b.size(filter.metric)
            .cmp(&a.size(filter.metric))
            .then(a.id.cmp(&b.id))
    });
    let mut categories = BTreeMap::<Category, (u64, usize)>::new();
    let mut bytes = 0u64;
    for r in &records {
        let size = r.size(filter.metric);
        bytes = bytes.saturating_add(size);
        let total = categories.entry(r.category).or_default();
        total.0 = total.0.saturating_add(size);
        total.1 += 1;
    }
    let total = records.len();
    let offset = offset.min(total.saturating_sub(1) / PAGE_SIZE * PAGE_SIZE);
    let files = records
        .iter()
        .skip(offset)
        .take(PAGE_SIZE)
        .map(|r| r.summary(index.now))
        .collect();
    let nodes = make_nodes(&records, filter.metric, index.now);
    Ok(View {
        scan_id: index.scan_id,
        revision: index.revision,
        total,
        bytes,
        offset,
        files,
        nodes,
        categories: categories
            .into_iter()
            .map(|(category, (bytes, count))| CategoryTotal {
                category,
                bytes,
                count,
            })
            .collect(),
        directory_id: 0,
        breadcrumbs: index.breadcrumbs(0)?,
        entries: Vec::new(),
        entry_total: 0,
    })
}

fn matches(index: &Index, r: &Record, filter: &Filter, needle: &str, bucket: bool) -> bool {
    let size = r.size(filter.metric);
    let age = age_bucket(r.fingerprint.modified.map(time_ms), index.now);
    if filter.category.is_some_and(|c| r.category != c) || size < filter.min_bytes {
        return false;
    }
    if filter.duplicates_only && r.duplicate_group.is_none() {
        return false;
    }
    if filter
        .duplicate_group
        .is_some_and(|g| r.duplicate_group != Some(g))
    {
        return false;
    }
    if filter.screenshots_only && !r.screenshot {
        return false;
    }
    if let Some(days) = filter.older_days {
        let Some(modified) = r.fingerprint.modified.map(time_ms) else {
            return false;
        };
        if index.now.saturating_sub(modified) < days as u64 * 86_400_000 {
            return false;
        }
    }
    if bucket {
        if let Some(b) = &filter.bucket {
            if r.category != b.category || age != b.age || r.screenshot != b.screenshot {
                return false;
            }
            if size > b.after.bytes || (size == b.after.bytes && r.id <= b.after.id) {
                return false;
            }
            if size < b.through.bytes || (size == b.through.bytes && r.id > b.through.id) {
                return false;
            }
        }
    }
    needle.is_empty() || r.relative.to_string_lossy().to_lowercase().contains(needle)
}

fn folder_query(index: &Index, filter: &Filter, offset: usize) -> Result<View> {
    struct Candidate {
        entry: DirectoryEntry,
        file_id: Option<u64>,
    }
    let directory_id = filter.directory_id.unwrap_or(0);
    let directory = index.directory(directory_id)?;
    let needle = filter.text.to_lowercase();
    let matching: Vec<&Record> = index
        .records
        .iter()
        .filter(|r| !r.removed && matches(index, r, filter, &needle, true))
        .filter(|r| r.relative.starts_with(&directory.relative))
        .collect();
    let mut bytes = 0u64;
    for r in &matching {
        bytes = bytes.saturating_add(r.size(filter.metric));
    }

    let mut child_dirs: BTreeMap<u64, (u64, usize)> = BTreeMap::new();
    let mut direct_files = Vec::new();
    for r in &matching {
        let parent = r
            .relative
            .parent()
            .unwrap_or_else(|| std::path::Path::new(""));
        if parent == directory.relative {
            direct_files.push(*r);
        } else if let Some(child_path) = r
            .relative
            .strip_prefix(&directory.relative)
            .ok()
            .and_then(|p| p.components().next())
        {
            let child_relative = directory.relative.join(child_path.as_os_str());
            if let Some(&child_id) = index.directory_ids.get(&child_relative) {
                let total = child_dirs.entry(child_id).or_default();
                total.0 = total.0.saturating_add(r.size(filter.metric));
                total.1 += 1;
            }
        }
    }
    if folder_filter_is_inactive(filter) {
        for child in index
            .directories
            .iter()
            .filter(|d| d.parent == Some(directory_id))
        {
            child_dirs.entry(child.id).or_default();
        }
    }
    direct_files.sort_unstable_by(|a, b| {
        b.size(filter.metric)
            .cmp(&a.size(filter.metric))
            .then(a.id.cmp(&b.id))
    });
    let mut candidates: Vec<Candidate> = child_dirs
        .into_iter()
        .map(|(id, (bytes, count))| {
            let name = index
                .directory(id)
                .map(|d| d.name.clone())
                .unwrap_or_default();
            Candidate {
                entry: DirectoryEntry {
                    directory_id: Some(id),
                    file: None,
                    name,
                    bytes,
                    count,
                },
                file_id: None,
            }
        })
        .collect();
    candidates.extend(direct_files.iter().map(|r| Candidate {
        entry: DirectoryEntry {
            directory_id: None,
            file: None,
            name: r.name(),
            bytes: r.size(filter.metric),
            count: 1,
        },
        file_id: Some(r.id),
    }));
    candidates.sort_unstable_by(|a, b| {
        b.entry
            .bytes
            .cmp(&a.entry.bytes)
            .then(a.entry.name.cmp(&b.entry.name))
    });
    let entry_total = candidates.len();
    let offset = offset.min(entry_total.saturating_sub(1) / PAGE_SIZE * PAGE_SIZE);
    let page_candidates: Vec<Candidate> = candidates
        .into_iter()
        .skip(offset)
        .take(PAGE_SIZE)
        .collect();
    let page: Vec<DirectoryEntry> = page_candidates
        .into_iter()
        .map(|candidate| {
            let mut entry = candidate.entry;
            entry.file = candidate
                .file_id
                .and_then(|id| index.record(id).ok())
                .map(|record| record.summary(index.now));
            entry
        })
        .collect();
    let files = page.iter().filter_map(|entry| entry.file.clone()).collect();
    Ok(View {
        scan_id: index.scan_id,
        revision: index.revision,
        total: matching.len(),
        bytes,
        offset,
        files,
        nodes: Vec::new(),
        categories: Vec::new(),
        directory_id,
        breadcrumbs: index.breadcrumbs(directory_id)?,
        entries: page,
        entry_total,
    })
}

fn folder_filter_is_inactive(filter: &Filter) -> bool {
    filter.text.is_empty()
        && filter.category.is_none()
        && filter.min_bytes == 0
        && filter.older_days.is_none()
        && !filter.duplicates_only
        && !filter.screenshots_only
        && filter.bucket.is_none()
        && filter.duplicate_group.is_none()
}
fn make_nodes(records: &[&Record], metric: Metric, now: u64) -> Vec<MapNode> {
    let mut nodes: Vec<_> = records
        .iter()
        .take(MAP_FILES)
        .map(|r| MapNode {
            key: format!("f{}", r.id),
            label: r.name(),
            bytes: r.size(metric),
            count: 1,
            category: r.category,
            age_bucket: age_bucket(r.fingerprint.modified.map(time_ms), now),
            file_id: Some(r.id),
            duplicate_group: r.duplicate_group,
            screenshot: r.screenshot,
            bucket: None,
        })
        .collect();
    if records.len() <= MAP_FILES {
        return nodes;
    }
    let last = records[MAP_FILES - 1];
    let cursor = Cursor {
        bytes: last.size(metric),
        id: last.id,
    };
    let mut groups = BTreeMap::<(Category, u8, bool), Vec<&Record>>::new();
    for r in records.iter().skip(MAP_FILES) {
        groups
            .entry((
                r.category,
                age_bucket(r.fingerprint.modified.map(time_ms), now),
                r.screenshot,
            ))
            .or_default()
            .push(*r);
    }
    // Spend the fixed group budget across natural buckets. A very large homogeneous
    // bucket is split into cursor ranges, so drill-down is logarithmic rather than
    // peeling only MAP_FILES entries on every click.
    let mut grouped: Vec<_> = groups
        .into_iter()
        .map(|(key, rows)| (key, rows, 1usize))
        .collect();
    let group_budget = 96usize.min(records.len() - MAP_FILES);
    while grouped.iter().map(|(_, _, parts)| *parts).sum::<usize>() < group_budget {
        let Some((index, _)) = grouped
            .iter()
            .enumerate()
            .filter(|(_, (_, rows, parts))| *parts < rows.len())
            .max_by_key(|(_, (_, rows, parts))| rows.len().div_ceil(*parts))
        else {
            break;
        };
        grouped[index].2 += 1;
    }
    for ((category, age, screenshot), rows, parts) in grouped {
        let chunk_size = rows.len().div_ceil(parts);
        for (part, chunk) in rows.chunks(chunk_size).enumerate() {
            let previous = if part == 0 {
                cursor.clone()
            } else {
                let prior = rows[part * chunk_size - 1];
                Cursor {
                    bytes: prior.size(metric),
                    id: prior.id,
                }
            };
            let last = chunk[chunk.len() - 1];
            let through = Cursor {
                bytes: last.size(metric),
                id: last.id,
            };
            let bytes = chunk
                .iter()
                .fold(0u64, |sum, r| sum.saturating_add(r.size(metric)));
            let count = chunk.len();
            nodes.push(MapNode {
                key: format!(
                    "g{category:?}{age}{screenshot}-{}-{}",
                    previous.id, through.id
                ),
                label: format!("Ещё {count} файлов"),
                bytes,
                count,
                category,
                age_bucket: age,
                file_id: None,
                duplicate_group: None,
                screenshot,
                bucket: Some(Bucket {
                    category,
                    age,
                    screenshot,
                    after: previous,
                    through,
                }),
            });
        }
    }
    nodes
}
