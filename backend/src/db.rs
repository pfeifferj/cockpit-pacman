use alpm::{Alpm, Db, Package};
use alpm_utils::DbListExt;
use std::collections::HashMap;
use std::sync::Mutex;

static REPO_MAP_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn find_package_repo(handle: &Alpm, pkg_name: &str) -> Option<String> {
    handle
        .syncdbs()
        .pkg(pkg_name)
        .ok()
        .and_then(|pkg: &Package| pkg.db())
        .map(|db: &Db| db.name().to_string())
}

pub fn get_repo_map(handle: &Alpm) -> HashMap<String, String> {
    let mut cache = REPO_MAP_CACHE.lock().unwrap();
    if let Some(ref map) = *cache {
        return map.clone();
    }

    let map = build_repo_map_uncached(handle);
    *cache = Some(map.clone());
    map
}

pub fn invalidate_repo_map_cache() {
    let mut cache = REPO_MAP_CACHE.lock().unwrap();
    *cache = None;
}

fn build_repo_map_uncached(handle: &Alpm) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for db in handle.syncdbs() {
        let repo_name = db.name().to_string();
        for pkg in db.pkgs() {
            map.insert(pkg.name().to_string(), repo_name.clone());
        }
    }
    map
}
