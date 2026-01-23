use alpm::{Alpm, Db, Package};
use alpm_utils::DbListExt;
use std::collections::HashMap;
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

pub fn get_repo_map(handle: &Alpm) -> Arc<RepoMap> {
    let mut cache = REPO_MAP_CACHE.lock().unwrap();
    if let Some(ref map) = *cache {
        return Arc::clone(map);
    }

    let map = Arc::new(build_repo_map_uncached(handle));
    *cache = Some(Arc::clone(&map));
    map
}

pub fn invalidate_repo_map_cache() {
    let mut cache = REPO_MAP_CACHE.lock().unwrap();
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
