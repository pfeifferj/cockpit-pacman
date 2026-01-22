use anyhow::Result;
use std::collections::{HashSet, VecDeque};

use crate::alpm::{get_handle, reason_to_string};
use crate::db::get_repo_map;
use crate::models::{DependencyEdge, DependencyNode, DependencyTreeResponse};

const MAX_NODES: usize = 500;

pub fn get_dependency_tree(name: &str, depth: u32, direction: &str) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let repo_map = get_repo_map(&handle);

    let mut nodes: Vec<DependencyNode> = Vec::new();
    let mut edges: Vec<DependencyEdge> = Vec::new();
    let mut edge_set: HashSet<(String, String)> = HashSet::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut max_depth_reached = false;

    let root_pkg = localdb
        .pkg(name)
        .ok()
        .or_else(|| handle.syncdbs().iter().find_map(|db| db.pkg(name).ok()));

    let (root_name, root_version, root_installed, root_reason, root_repo) = match root_pkg {
        Some(pkg) => {
            let is_installed = localdb.pkg(pkg.name()).is_ok();
            let reason = if is_installed {
                Some(reason_to_string(localdb.pkg(pkg.name()).unwrap().reason()).to_string())
            } else {
                None
            };
            let repo = repo_map.get(pkg.name()).cloned().or_else(|| {
                handle
                    .syncdbs()
                    .iter()
                    .find(|db| db.pkg(pkg.name()).is_ok())
                    .map(|db| db.name().to_string())
            });
            (
                pkg.name().to_string(),
                pkg.version().to_string(),
                is_installed,
                reason,
                repo,
            )
        }
        None => {
            anyhow::bail!("Package '{}' not found", name);
        }
    };

    let root_id = root_name.clone();
    nodes.push(DependencyNode {
        id: root_id.clone(),
        name: root_name.clone(),
        version: root_version,
        depth: 0,
        installed: root_installed,
        reason: root_reason,
        repository: root_repo,
    });
    visited.insert(root_name.clone());

    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    queue.push_back((root_name.clone(), 0));

    while let Some((pkg_name, current_depth)) = queue.pop_front() {
        if current_depth >= depth {
            max_depth_reached = true;
            continue;
        }

        if nodes.len() >= MAX_NODES {
            warnings.push(format!(
                "Graph truncated at {} nodes for performance",
                MAX_NODES
            ));
            break;
        }

        let pkg = localdb.pkg(pkg_name.as_str()).ok().or_else(|| {
            handle
                .syncdbs()
                .iter()
                .find_map(|db| db.pkg(pkg_name.as_str()).ok())
        });

        let Some(pkg) = pkg else {
            continue;
        };

        if direction == "forward" || direction == "both" {
            for dep in pkg.depends() {
                let dep_name = dep.name().to_string();
                add_dependency(
                    &handle,
                    localdb,
                    &repo_map,
                    &dep_name,
                    &pkg_name,
                    "depends",
                    current_depth + 1,
                    &mut nodes,
                    &mut edges,
                    &mut edge_set,
                    &mut visited,
                    &mut queue,
                    &mut warnings,
                );
            }

            for dep in pkg.optdepends() {
                let dep_name = dep.name().to_string();
                add_dependency(
                    &handle,
                    localdb,
                    &repo_map,
                    &dep_name,
                    &pkg_name,
                    "optdepends",
                    current_depth + 1,
                    &mut nodes,
                    &mut edges,
                    &mut edge_set,
                    &mut visited,
                    &mut queue,
                    &mut warnings,
                );
            }
        }

        if direction == "reverse" || direction == "both" {
            for req_name in pkg.required_by() {
                add_dependency(
                    &handle,
                    localdb,
                    &repo_map,
                    &req_name,
                    &pkg_name,
                    "required_by",
                    current_depth + 1,
                    &mut nodes,
                    &mut edges,
                    &mut edge_set,
                    &mut visited,
                    &mut queue,
                    &mut warnings,
                );
            }

            for opt_name in pkg.optional_for() {
                add_dependency(
                    &handle,
                    localdb,
                    &repo_map,
                    &opt_name,
                    &pkg_name,
                    "optional_for",
                    current_depth + 1,
                    &mut nodes,
                    &mut edges,
                    &mut edge_set,
                    &mut visited,
                    &mut queue,
                    &mut warnings,
                );
            }
        }
    }

    let response = DependencyTreeResponse {
        nodes,
        edges,
        root: root_id,
        max_depth_reached,
        warnings,
    };

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_dependency(
    handle: &alpm::Alpm,
    localdb: &alpm::Db,
    repo_map: &std::sync::Arc<std::collections::HashMap<String, String>>,
    dep_name: &str,
    source_name: &str,
    edge_type: &str,
    new_depth: u32,
    nodes: &mut Vec<DependencyNode>,
    edges: &mut Vec<DependencyEdge>,
    edge_set: &mut HashSet<(String, String)>,
    visited: &mut HashSet<String>,
    queue: &mut VecDeque<(String, u32)>,
    warnings: &mut Vec<String>,
) {
    let (edge_source, edge_target) = match edge_type {
        "required_by" | "optional_for" => (dep_name.to_string(), source_name.to_string()),
        _ => (source_name.to_string(), dep_name.to_string()),
    };

    let edge_key = (edge_source.clone(), edge_target.clone());
    if !edge_set.contains(&edge_key) {
        edge_set.insert(edge_key);
        edges.push(DependencyEdge {
            source: edge_source,
            target: edge_target,
            edge_type: edge_type.to_string(),
        });
    }

    if visited.contains(dep_name) {
        return;
    }

    visited.insert(dep_name.to_string());

    let dep_pkg = localdb
        .pkg(dep_name)
        .ok()
        .or_else(|| handle.syncdbs().iter().find_map(|db| db.pkg(dep_name).ok()));

    let (version, installed, reason, repository) = match &dep_pkg {
        Some(pkg) => {
            let is_installed = localdb.pkg(pkg.name()).is_ok();
            let reason = if is_installed {
                Some(reason_to_string(localdb.pkg(pkg.name()).unwrap().reason()).to_string())
            } else {
                None
            };
            let repo = repo_map.get(pkg.name()).cloned().or_else(|| {
                handle
                    .syncdbs()
                    .iter()
                    .find(|db| db.pkg(pkg.name()).is_ok())
                    .map(|db| db.name().to_string())
            });
            (pkg.version().to_string(), is_installed, reason, repo)
        }
        None => {
            if !warnings.iter().any(|w| w.contains(dep_name)) {
                warnings.push(format!("Package '{}' not found in databases", dep_name));
            }
            ("unknown".to_string(), false, None, None)
        }
    };

    nodes.push(DependencyNode {
        id: dep_name.to_string(),
        name: dep_name.to_string(),
        version,
        depth: new_depth,
        installed,
        reason,
        repository,
    });

    queue.push_back((dep_name.to_string(), new_depth));
}
