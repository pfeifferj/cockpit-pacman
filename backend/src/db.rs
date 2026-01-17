use alpm::{Alpm, Db, Package};
use alpm_utils::DbListExt;
use std::collections::HashMap;

pub fn find_package_repo(handle: &Alpm, pkg_name: &str) -> Option<String> {
    handle
        .syncdbs()
        .pkg(pkg_name)
        .ok()
        .and_then(|pkg: &Package| pkg.db())
        .map(|db: &Db| db.name().to_string())
}

pub fn build_repo_map(handle: &Alpm) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for db in handle.syncdbs() {
        let repo_name = db.name().to_string();
        for pkg in db.pkgs() {
            map.insert(pkg.name().to_string(), repo_name.clone());
        }
    }
    map
}
