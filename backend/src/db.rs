use alpm::{Alpm, Db, Package};
use alpm_utils::DbListExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub type RepoMap = HashMap<String, Arc<str>>;

static REPO_MAP_CACHE: Mutex<Option<Arc<RepoMap>>> = Mutex::new(None);

pub fn find_package_repo(handle: &Alpm, pkg_name: &str) -> Option<String> {
    handle
        .syncdbs()
        .pkg(pkg_name)
        .ok()
        .and_then(|pkg: &Package| pkg.db())
        .map(|db: &Db| db.name().to_string())
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct SyncDbSignature(Vec<(String, i64, u64)>);

#[derive(Serialize, Deserialize)]
struct RepoMapCache {
    signature: SyncDbSignature,
    map: HashMap<String, String>,
}

fn sync_db_signature(handle: &Alpm) -> SyncDbSignature {
    let dir = Path::new(handle.dbpath()).join("sync");
    let mut entries: Vec<(String, i64, u64)> = handle
        .syncdbs()
        .iter()
        .map(|db| {
            let name = db.name().to_string();
            let meta = std::fs::metadata(dir.join(format!("{name}.db"))).ok();
            let mtime = meta.as_ref().map_or(0, crate::util::mtime_secs);
            let size = meta.as_ref().map_or(0, |m| m.len());
            (name, mtime, size)
        })
        .collect();
    entries.sort();
    SyncDbSignature(entries)
}

fn repo_map_cache_path() -> Option<PathBuf> {
    crate::util::config_path("repo-map.json").ok()
}

pub fn get_repo_map(handle: &Alpm) -> Arc<RepoMap> {
    let mut cache = REPO_MAP_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(ref map) = *cache {
        return Arc::clone(map);
    }

    let signature = sync_db_signature(handle);
    let path = repo_map_cache_path();

    if let Some(ref p) = path
        && let Some(map) = read_repo_map_cache(p, &signature)
    {
        let map = Arc::new(map);
        *cache = Some(Arc::clone(&map));
        return map;
    }

    let map = Arc::new(build_repo_map_uncached(handle));
    if let Some(ref p) = path {
        let _ = write_repo_map_cache(p, signature, &map);
    }
    *cache = Some(Arc::clone(&map));
    map
}

fn read_repo_map_cache(path: &Path, signature: &SyncDbSignature) -> Option<RepoMap> {
    let content = std::fs::read_to_string(path).ok()?;
    let cached: RepoMapCache = serde_json::from_str(&content).ok()?;
    if cached.signature != *signature {
        return None;
    }

    let mut interned: HashMap<String, Arc<str>> = HashMap::new();
    let mut map = RepoMap::new();
    for (pkg, repo) in cached.map {
        let shared = match interned.get(&repo) {
            Some(s) => Arc::clone(s),
            None => {
                let s: Arc<str> = Arc::from(repo.as_str());
                interned.insert(repo, Arc::clone(&s));
                s
            }
        };
        map.insert(pkg, shared);
    }
    Some(map)
}

fn write_repo_map_cache(
    path: &Path,
    signature: SyncDbSignature,
    map: &RepoMap,
) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let cache = RepoMapCache {
        signature,
        map: map
            .iter()
            .map(|(k, v)| (k.clone(), v.to_string()))
            .collect(),
    };
    crate::util::write_json_atomic(path, &cache)
}

pub fn invalidate_repo_map_cache() {
    let mut cache = REPO_MAP_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = None;
}

fn build_repo_map_uncached(handle: &Alpm) -> RepoMap {
    let mut map = HashMap::new();
    for db in handle.syncdbs() {
        let repo_name: Arc<str> = Arc::from(db.name());
        for pkg in db.pkgs() {
            map.insert(pkg.name().to_string(), Arc::clone(&repo_name));
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::{RepoMap, SyncDbSignature, read_repo_map_cache, write_repo_map_cache};
    use std::sync::Arc;

    fn sig(entries: &[(&str, i64, u64)]) -> SyncDbSignature {
        SyncDbSignature(
            entries
                .iter()
                .map(|(n, m, s)| (n.to_string(), *m, *s))
                .collect(),
        )
    }

    fn write(path: &std::path::Path, signature: &SyncDbSignature) {
        let mut map = RepoMap::new();
        map.insert("bash".to_string(), Arc::from("core"));
        write_repo_map_cache(path, SyncDbSignature(signature.0.clone()), &map).expect("writes");
    }

    #[test]
    fn a_map_built_from_the_same_databases_is_reused() {
        let path = std::env::temp_dir().join(format!("cpac-rm-same-{}", std::process::id()));
        let s = sig(&[("core", 100, 4096)]);
        write(&path, &s);

        let got = read_repo_map_cache(&path, &s).expect("reused");
        assert_eq!(got.get("bash").map(|r| r.to_string()), Some("core".into()));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_map_built_before_a_sync_is_not_reused() {
        let path = std::env::temp_dir().join(format!("cpac-rm-stale-{}", std::process::id()));
        write(&path, &sig(&[("core", 100, 4096)]));

        assert!(read_repo_map_cache(&path, &sig(&[("core", 200, 4096)])).is_none());
        assert!(read_repo_map_cache(&path, &sig(&[("core", 100, 8192)])).is_none());
        assert!(
            read_repo_map_cache(&path, &sig(&[("core", 100, 4096), ("extra", 100, 4096)]))
                .is_none()
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_cache_that_is_not_readable_json_is_ignored() {
        let path = std::env::temp_dir().join(format!("cpac-rm-junk-{}", std::process::id()));
        std::fs::write(&path, "not json").expect("writes");
        assert!(read_repo_map_cache(&path, &sig(&[("core", 100, 4096)])).is_none());
        std::fs::remove_file(&path).ok();
    }
}
