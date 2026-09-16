use anyhow::Result;
use std::collections::{HashSet, VecDeque};

use crate::alpm::{get_handle, reason_to_string};
use crate::db::{RepoMap, get_repo_map};
use crate::models::{DependencyEdge, DependencyNode, DependencyTreeResponse};
use crate::util::emit_json;

const MAX_NODES: usize = 500;

pub fn get_dependency_tree(
    name: &str,
    depth: u32,
    direction: &str,
    optional_depth: u32,
) -> Result<()> {
    emit_json(&build_dependency_tree(
        name,
        depth,
        direction,
        optional_depth,
    )?)
}

pub fn build_dependency_tree(
    name: &str,
    depth: u32,
    direction: &str,
    optional_depth: u32,
) -> Result<DependencyTreeResponse> {
    let handle = get_handle()?;
    let repo_map = get_repo_map(&handle);
    build_dependency_tree_with_handle(&handle, &repo_map, name, depth, direction, optional_depth)
}

fn build_dependency_tree_with_handle(
    handle: &alpm::Alpm,
    repo_map: &RepoMap,
    name: &str,
    depth: u32,
    direction: &str,
    optional_depth: u32,
) -> Result<DependencyTreeResponse> {
    let localdb = handle.localdb();

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
            let local_pkg = localdb.pkg(pkg.name()).ok();
            let is_installed = local_pkg.is_some();
            let reason = local_pkg.map(|lp| reason_to_string(lp.reason()).to_string());
            let repo = repo_map.get(pkg.name()).map(|s| s.to_string()).or_else(|| {
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
            note_truncation(&mut warnings);
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
                    handle,
                    localdb,
                    repo_map,
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

            if current_depth < optional_depth {
                for dep in pkg.optdepends() {
                    let dep_name = dep.name().to_string();
                    add_dependency(
                        handle,
                        localdb,
                        repo_map,
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
        }

        if direction == "reverse" || direction == "both" {
            for req_name in pkg.required_by() {
                add_dependency(
                    handle,
                    localdb,
                    repo_map,
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

            if current_depth < optional_depth {
                for opt_name in pkg.optional_for() {
                    add_dependency(
                        handle,
                        localdb,
                        repo_map,
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
    }

    Ok(DependencyTreeResponse {
        nodes,
        edges,
        root: root_id,
        max_depth_reached,
        warnings,
    })
}

fn note_truncation(warnings: &mut Vec<String>) {
    let message = format!("Graph truncated at {} nodes for performance", MAX_NODES);
    if !warnings.contains(&message) {
        warnings.push(message);
    }
}

#[allow(clippy::too_many_arguments)]
fn add_dependency(
    handle: &alpm::Alpm,
    localdb: &alpm::Db,
    repo_map: &RepoMap,
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
    // Use find_satisfier to resolve provides (e.g., libcurl.so -> curl)
    let dep_pkg = localdb
        .pkgs()
        .find_satisfier(dep_name)
        .or_else(|| handle.syncdbs().find_satisfier(dep_name));

    let (resolved_name, version, installed, reason, repository) = match &dep_pkg {
        Some(pkg) => {
            let local_pkg = localdb.pkg(pkg.name()).ok();
            let is_installed = local_pkg.is_some();
            let reason = local_pkg.map(|lp| reason_to_string(lp.reason()).to_string());
            let repo = repo_map.get(pkg.name()).map(|s| s.to_string()).or_else(|| {
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
            if !warnings.iter().any(|w| w.contains(dep_name)) {
                warnings.push(format!("Package '{}' not found in databases", dep_name));
            }
            return;
        }
    };

    if !visited.contains(&resolved_name) && nodes.len() >= MAX_NODES {
        note_truncation(warnings);
        return;
    }

    // Use resolved package name for edges and deduplication
    let (edge_source, edge_target) = match edge_type {
        "required_by" | "optional_for" => (resolved_name.clone(), source_name.to_string()),
        _ => (source_name.to_string(), resolved_name.clone()),
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

    if visited.contains(&resolved_name) {
        return;
    }

    visited.insert(resolved_name.clone());

    nodes.push(DependencyNode {
        id: resolved_name.clone(),
        name: resolved_name.clone(),
        version,
        depth: new_depth,
        installed,
        reason,
        repository,
    });

    queue.push_back((resolved_name, new_depth));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestDb(PathBuf);

    impl TestDb {
        fn new(packages: &[(&str, &[&str], &[&str])]) -> Self {
            static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "cpac-dependency-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let fixture = Self(path);
            let local = fixture.0.join("local");
            std::fs::create_dir_all(&local).unwrap();
            std::fs::write(local.join("ALPM_DB_VERSION"), "9\n").unwrap();
            for (name, depends, optdepends) in packages {
                let package_dir = local.join(format!("{name}-1-1"));
                std::fs::create_dir(&package_dir).unwrap();
                let mut desc = format!("%NAME%\n{name}\n\n%VERSION%\n1-1\n\n%REASON%\n0\n\n");
                for (field, values) in [("DEPENDS", depends), ("OPTDEPENDS", optdepends)] {
                    if !values.is_empty() {
                        desc.push_str(&format!("%{field}%\n{}\n\n", values.join("\n")));
                    }
                }
                std::fs::write(package_dir.join("desc"), desc).unwrap();
            }
            fixture
        }

        fn tree(
            &self,
            name: &str,
            depth: u32,
            direction: &str,
            optional_depth: u32,
        ) -> DependencyTreeResponse {
            let path = self.0.to_str().unwrap();
            let handle = alpm::Alpm::new(path, path).unwrap();
            build_dependency_tree_with_handle(
                &handle,
                &RepoMap::new(),
                name,
                depth,
                direction,
                optional_depth,
            )
            .unwrap()
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn issue_133_db() -> TestDb {
        TestDb::new(&[
            ("libde265", &[], &[]),
            ("libheif", &["libde265"], &[]),
            ("gd", &["libheif"], &["perl: conversion script"]),
            ("graphviz", &["gd"], &[]),
            ("libmediainfo", &["graphviz"], &[]),
            ("glibc", &[], &["gd: memory usage graph"]),
            ("acl", &["glibc"], &[]),
            ("attr", &["glibc"], &[]),
            ("perl", &[], &[]),
        ])
    }

    fn node_names(tree: &DependencyTreeResponse) -> HashSet<&str> {
        tree.nodes.iter().map(|node| node.name.as_str()).collect()
    }

    fn assert_nodes(tree: &DependencyTreeResponse, expected: &[&str]) {
        let names = node_names(tree);
        assert_eq!(names, expected.iter().copied().collect());
        assert_eq!(tree.nodes.len(), names.len(), "nodes must be unique");
        assert!(tree.warnings.is_empty(), "{:?}", tree.warnings);
        let mut edges = HashSet::new();
        for edge in &tree.edges {
            assert!(names.contains(edge.source.as_str()));
            assert!(names.contains(edge.target.as_str()));
            assert!(edges.insert((&edge.source, &edge.target)), "duplicate edge");
        }
    }

    #[test]
    fn zero_optional_depth_excludes_optional_branches_in_every_direction() {
        let db = issue_133_db();
        for direction in ["forward", "reverse", "both"] {
            let root = if direction == "forward" {
                "glibc"
            } else {
                "libde265"
            };
            let tree = db.tree(root, 5, direction, 0);
            let expected: &[&str] = if direction == "forward" {
                &["glibc"]
            } else {
                &["libde265", "libheif", "gd", "graphviz", "libmediainfo"]
            };
            assert_nodes(&tree, expected);
            assert!(tree.edges.iter().all(|edge| {
                edge.edge_type != "optdepends" && edge.edge_type != "optional_for"
            }));
        }
    }

    #[test]
    fn reverse_optional_depth_counts_distance_from_the_root() {
        let db = issue_133_db();
        let shallow = db.tree("libde265", 5, "reverse", 2);
        assert_nodes(
            &shallow,
            &["libde265", "libheif", "gd", "graphviz", "libmediainfo"],
        );

        let deeper = db.tree("libde265", 5, "reverse", 3);
        assert_nodes(
            &deeper,
            &[
                "libde265",
                "libheif",
                "gd",
                "graphviz",
                "libmediainfo",
                "glibc",
                "acl",
                "attr",
            ],
        );
        assert!(deeper.edges.iter().any(|edge| {
            edge.source == "glibc" && edge.target == "gd" && edge.edge_type == "optional_for"
        }));
        assert_eq!(
            deeper
                .nodes
                .iter()
                .find(|node| node.name == "glibc")
                .unwrap()
                .depth,
            3
        );
        assert_eq!(
            deeper
                .nodes
                .iter()
                .find(|node| node.name == "acl")
                .unwrap()
                .depth,
            4
        );
    }

    #[test]
    fn forward_optional_depth_keeps_required_descendants_of_optional_packages() {
        let db = issue_133_db();
        let immediate = db.tree("glibc", 5, "forward", 1);
        assert_nodes(&immediate, &["glibc", "gd", "libheif", "libde265"]);
        assert!(immediate.edges.iter().any(|edge| {
            edge.source == "glibc" && edge.target == "gd" && edge.edge_type == "optdepends"
        }));

        let deeper = db.tree("glibc", 5, "forward", 2);
        assert_nodes(&deeper, &["glibc", "gd", "libheif", "libde265", "perl"]);
    }

    #[test]
    fn both_directions_include_only_immediate_optional_edges_at_depth_one() {
        let db = TestDb::new(&[
            ("root", &["required"], &["optional"]),
            ("required", &[], &["nested-forward"]),
            ("optional", &["leaf"], &[]),
            ("leaf", &[], &[]),
            ("consumer", &["root"], &[]),
            ("optional-consumer", &[], &["root"]),
            ("nested-reverse", &[], &["consumer"]),
            ("nested-forward", &[], &[]),
        ]);
        let immediate = db.tree("root", 5, "both", 1);
        assert_nodes(
            &immediate,
            &[
                "root",
                "required",
                "optional",
                "leaf",
                "consumer",
                "optional-consumer",
            ],
        );
        assert!(immediate.edges.iter().any(|edge| {
            edge.source == "root" && edge.target == "optional" && edge.edge_type == "optdepends"
        }));
        assert!(immediate.edges.iter().any(|edge| {
            edge.source == "optional-consumer"
                && edge.target == "root"
                && edge.edge_type == "optional_for"
        }));
        let deeper = db.tree("root", 5, "both", 2);
        assert_nodes(
            &deeper,
            &[
                "root",
                "required",
                "optional",
                "leaf",
                "consumer",
                "optional-consumer",
                "nested-forward",
                "nested-reverse",
            ],
        );
    }

    #[test]
    fn optional_depth_cannot_extend_the_total_depth() {
        let db = issue_133_db();
        for direction in ["forward", "reverse", "both"] {
            let tree = db.tree("glibc", 1, direction, 5);
            let expected: &[&str] = match direction {
                "forward" => &["glibc", "gd"],
                "reverse" => &["glibc", "acl", "attr"],
                _ => &["glibc", "gd", "acl", "attr"],
            };
            assert_nodes(&tree, expected);
            assert!(tree.nodes.iter().all(|node| node.depth <= 1));
            assert!(tree.max_depth_reached);
        }
    }

    #[test]
    fn cycles_and_reconverging_paths_keep_the_shortest_optional_depth() {
        let db = TestDb::new(&[
            ("root", &["long", "shared"], &[]),
            ("long", &["middle"], &[]),
            ("middle", &["shared"], &[]),
            ("shared", &["root"], &["optional"]),
            ("optional", &[], &[]),
        ]);
        let tree = db.tree("root", 5, "forward", 2);
        assert_nodes(&tree, &["root", "long", "middle", "shared", "optional"]);
        assert_eq!(
            tree.nodes
                .iter()
                .find(|node| node.name == "optional")
                .unwrap()
                .depth,
            2
        );
        assert_eq!(tree.edges.len(), 6);
    }

    #[test]
    fn note_truncation_appends_the_warning() {
        let mut warnings = Vec::new();
        note_truncation(&mut warnings);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains(&MAX_NODES.to_string()));
    }

    #[test]
    fn note_truncation_does_not_duplicate_the_warning() {
        let mut warnings = Vec::new();
        note_truncation(&mut warnings);
        note_truncation(&mut warnings);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn note_truncation_keeps_unrelated_warnings() {
        let mut warnings = vec!["Package 'foo' not found in databases".to_string()];
        note_truncation(&mut warnings);
        assert_eq!(warnings.len(), 2);
    }
}
