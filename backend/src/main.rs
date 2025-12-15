use alpm::{
    Alpm, AnyDownloadEvent, AnyEvent, AnyQuestion, DownloadEvent, Event, LogLevel,
    PackageOperation, Progress, Question, TransFlag,
};
use alpm_utils::{alpm_with_conf, DbListExt};
use anyhow::{Context, Result};
use pacmanconf::Config;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashSet;
use std::env;
use std::io::{self, Write};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Global flag for cancellation
static CANCELLED: AtomicBool = AtomicBool::new(false);

fn is_cancelled() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

fn setup_signal_handler() {
    static HANDLER_SET: AtomicBool = AtomicBool::new(false);
    if HANDLER_SET.swap(true, Ordering::SeqCst) {
        return;
    }

    if let Err(e) = ctrlc::set_handler(move || {
        CANCELLED.store(true, Ordering::SeqCst);
    }) {
        eprintln!("Warning: Failed to set signal handler: {}", e);
    }
}

#[cfg(test)]
mod tests;

#[derive(Serialize)]
struct Package {
    name: String,
    version: String,
    description: Option<String>,
    installed_size: i64,
    install_date: Option<i64>,
    reason: String,
    repository: Option<String>,
}

#[derive(Serialize)]
struct PackageListResponse {
    packages: Vec<Package>,
    total: usize,
    total_explicit: usize,
    total_dependency: usize,
    repositories: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct UpdatesResponse {
    updates: Vec<UpdateInfo>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct UpdateInfo {
    name: String,
    current_version: String,
    new_version: String,
    download_size: i64,
    current_size: i64,
    new_size: i64,
    repository: String,
}

#[derive(Serialize)]
struct PackageDetails {
    name: String,
    version: String,
    description: Option<String>,
    url: Option<String>,
    licenses: Vec<String>,
    groups: Vec<String>,
    provides: Vec<String>,
    depends: Vec<String>,
    optdepends: Vec<String>,
    conflicts: Vec<String>,
    replaces: Vec<String>,
    installed_size: i64,
    packager: Option<String>,
    architecture: Option<String>,
    build_date: i64,
    install_date: Option<i64>,
    reason: String,
    validation: Vec<String>,
    repository: Option<String>,
}

#[derive(Serialize)]
struct SearchResult {
    name: String,
    version: String,
    description: Option<String>,
    repository: String,
    installed: bool,
    installed_version: Option<String>,
}

fn get_handle() -> Result<Alpm> {
    let conf = Config::new().context("Failed to parse pacman.conf")?;
    alpm_with_conf(&conf).context("Failed to initialize alpm handle")
}

// Streaming event types for real-time progress updates
#[derive(Serialize)]
#[serde(tag = "type")]
enum StreamEvent {
    #[serde(rename = "log")]
    Log { level: String, message: String },
    #[serde(rename = "progress")]
    Progress {
        operation: String,
        package: String,
        percent: i32,
        current: usize,
        total: usize,
    },
    #[serde(rename = "download")]
    Download {
        filename: String,
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        downloaded: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<i64>,
    },
    #[serde(rename = "event")]
    Event {
        event: String,
        package: Option<String>,
    },
    #[serde(rename = "complete")]
    Complete {
        success: bool,
        message: Option<String>,
    },
}

#[derive(Serialize, Clone)]
struct KeyInfo {
    fingerprint: String,
    uid: String,
}

// Preflight check response types
#[derive(Serialize, Default)]
struct PreflightResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    conflicts: Vec<ConflictInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    replacements: Vec<ReplacementInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    removals: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    providers: Vec<ProviderChoice>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    import_keys: Vec<KeyInfo>,
    packages_to_upgrade: usize,
    total_download_size: i64,
}

#[derive(Serialize, Clone)]
struct ConflictInfo {
    package1: String,
    package2: String,
}

#[derive(Serialize, Clone)]
struct ReplacementInfo {
    old_package: String,
    new_package: String,
}

#[derive(Serialize, Clone)]
struct ProviderChoice {
    dependency: String,
    providers: Vec<String>,
}

fn emit_event(event: &StreamEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        println!("{}", json);
        let _ = io::stdout().flush();
    }
}

fn progress_to_string(progress: Progress) -> &'static str {
    match progress {
        Progress::AddStart => "add_start",
        Progress::UpgradeStart => "upgrade_start",
        Progress::DowngradeStart => "downgrade_start",
        Progress::ReinstallStart => "reinstall_start",
        Progress::RemoveStart => "remove_start",
        Progress::ConflictsStart => "conflicts_start",
        Progress::DiskspaceStart => "diskspace_start",
        Progress::IntegrityStart => "integrity_start",
        Progress::LoadStart => "load_start",
        Progress::KeyringStart => "keyring_start",
    }
}

fn reason_to_string(reason: alpm::PackageReason) -> &'static str {
    match reason {
        alpm::PackageReason::Explicit => "explicit",
        alpm::PackageReason::Depend => "dependency",
    }
}

fn log_level_to_string(level: LogLevel) -> &'static str {
    match level {
        LogLevel::ERROR => "error",
        LogLevel::WARNING => "warning",
        LogLevel::DEBUG => "debug",
        LogLevel::FUNCTION => "function",
        _ => "info",
    }
}

fn setup_log_cb(handle: &mut Alpm) {
    handle.set_log_cb((), |level: LogLevel, msg: &str, _: &mut ()| {
        emit_event(&StreamEvent::Log {
            level: log_level_to_string(level).to_string(),
            message: msg.trim().to_string(),
        });
    });
}

fn setup_dl_cb(handle: &mut Alpm) {
    handle.set_dl_cb((), |filename: &str, event: AnyDownloadEvent, _: &mut ()| {
        let (event_str, downloaded, total) = match event.event() {
            DownloadEvent::Init(_) => ("init", None, None),
            DownloadEvent::Progress(p) => ("progress", Some(p.downloaded), Some(p.total)),
            DownloadEvent::Retry(_) => ("retry", None, None),
            DownloadEvent::Completed(c) => ("completed", None, Some(c.total)),
        };
        emit_event(&StreamEvent::Download {
            filename: filename.to_string(),
            event: event_str.to_string(),
            downloaded,
            total,
        });
    });
}

fn validate_package_name(name: &str) -> Result<()> {
    if name.is_empty() {
        anyhow::bail!("Package name cannot be empty");
    }
    if name.len() > 256 {
        anyhow::bail!("Package name too long (max 256)");
    }
    Ok(())
}

fn validate_search_query(query: &str) -> Result<()> {
    if query.is_empty() {
        anyhow::bail!("Search query cannot be empty");
    }
    if query.len() > 256 {
        anyhow::bail!("Search query too long (max 256)");
    }
    if query.chars().any(|c| c.is_control()) {
        anyhow::bail!("Search query contains invalid characters");
    }
    Ok(())
}

fn validate_pagination(offset: usize, limit: usize) -> Result<()> {
    if limit == 0 || limit > 1000 {
        anyhow::bail!("Limit must be between 1 and 1000");
    }
    if offset > 1_000_000 {
        anyhow::bail!("Offset too large");
    }
    Ok(())
}

fn find_package_repo(handle: &Alpm, pkg_name: &str) -> Option<String> {
    handle
        .syncdbs()
        .pkg(pkg_name)
        .ok()
        .and_then(|pkg| pkg.db())
        .map(|db| db.name().to_string())
}

fn list_installed(
    offset: usize,
    limit: usize,
    search: Option<&str>,
    filter: Option<&str>,
    repo_filter: Option<&str>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();

    let search_lower = search.map(|s| s.to_lowercase());
    let filter_reason = filter.and_then(|f| match f {
        "explicit" => Some(alpm::PackageReason::Explicit),
        "dependency" => Some(alpm::PackageReason::Depend),
        _ => None,
    });

    let mut repo_set: HashSet<String> = HashSet::new();

    // First pass: collect all packages with their repos
    let all_with_repos: Vec<_> = localdb
        .pkgs()
        .iter()
        .map(|pkg| {
            let repo = find_package_repo(&handle, pkg.name());
            if let Some(ref r) = repo {
                repo_set.insert(r.clone());
            } else {
                repo_set.insert("user".to_string());
            }
            (pkg, repo)
        })
        .collect();

    // Second pass: apply search and repo filters, count by reason
    let mut total_explicit = 0usize;
    let mut total_dependency = 0usize;
    let search_and_repo_filtered: Vec<_> = all_with_repos
        .iter()
        .filter(|(pkg, repo)| {
            if let Some(ref query) = search_lower {
                let name_match = pkg.name().to_lowercase().contains(query);
                let desc_match = pkg
                    .desc()
                    .map(|d| d.to_lowercase().contains(query))
                    .unwrap_or(false);
                if !name_match && !desc_match {
                    return false;
                }
            }

            if let Some(repo_f) = repo_filter {
                let pkg_repo = repo.as_deref().unwrap_or("user");
                if pkg_repo != repo_f {
                    return false;
                }
            }

            // Count after search/repo filter but before reason filter
            match pkg.reason() {
                alpm::PackageReason::Explicit => total_explicit += 1,
                alpm::PackageReason::Depend => total_dependency += 1,
            }

            true
        })
        .collect();

    // Third pass: apply reason filter
    let mut filtered: Vec<_> = search_and_repo_filtered
        .into_iter()
        .filter(|(pkg, _repo)| {
            if let Some(reason) = filter_reason {
                return pkg.reason() == reason;
            }
            true
        })
        .collect();

    // Sort before pagination
    let ascending = sort_dir != Some("desc");
    match sort_by {
        Some("name") => {
            filtered.sort_by(|(a, _), (b, _)| {
                let cmp = a.name().cmp(b.name());
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        Some("size") => {
            filtered.sort_by(|(a, _), (b, _)| {
                let cmp = a.isize().cmp(&b.isize());
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        Some("reason") => {
            filtered.sort_by(|(a, _), (b, _)| {
                let reason_a = match a.reason() {
                    alpm::PackageReason::Explicit => "explicit",
                    alpm::PackageReason::Depend => "dependency",
                };
                let reason_b = match b.reason() {
                    alpm::PackageReason::Explicit => "explicit",
                    alpm::PackageReason::Depend => "dependency",
                };
                let cmp = reason_a.cmp(reason_b);
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        _ => {} // No sorting or unknown column - keep default order
    }

    let total = filtered.len();

    let packages: Vec<Package> = filtered
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(pkg, repo)| Package {
            name: pkg.name().to_string(),
            version: pkg.version().to_string(),
            description: pkg.desc().map(|s| s.to_string()),
            installed_size: pkg.isize(),
            install_date: pkg.install_date(),
            reason: reason_to_string(pkg.reason()).to_string(),
            repository: repo.clone(),
        })
        .collect();

    let mut repositories: Vec<String> = repo_set.into_iter().collect();
    repositories.sort();

    let response = PackageListResponse {
        packages,
        total,
        total_explicit,
        total_dependency,
        repositories,
        warnings: Vec::new(),
    };

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn check_updates() -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let mut updates: Vec<UpdateInfo> = Vec::new();

    for pkg in localdb.pkgs() {
        // Find the sync package and its repository
        for syncdb in handle.syncdbs() {
            if let Ok(syncpkg) = syncdb.pkg(pkg.name()) {
                if syncpkg.version() > pkg.version() {
                    updates.push(UpdateInfo {
                        name: pkg.name().to_string(),
                        current_version: pkg.version().to_string(),
                        new_version: syncpkg.version().to_string(),
                        download_size: syncpkg.download_size(),
                        current_size: pkg.isize(),
                        new_size: syncpkg.isize(),
                        repository: syncdb.name().to_string(),
                    });
                }
                break; // Found the package, no need to check other repos
            }
        }
    }

    let response = UpdatesResponse {
        updates,
        warnings: Vec::new(),
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn preflight_upgrade(ignore_pkgs: &[String]) -> Result<()> {
    let mut handle = get_handle()?;

    // Set ignored packages
    for pkg_name in ignore_pkgs {
        handle.add_ignorepkg(pkg_name.as_str())?;
    }

    // Collected issues that need user confirmation
    let conflicts = Rc::new(RefCell::new(Vec::<ConflictInfo>::new()));
    let replacements = Rc::new(RefCell::new(Vec::<ReplacementInfo>::new()));
    let removals = Rc::new(RefCell::new(Vec::<String>::new()));
    let providers = Rc::new(RefCell::new(Vec::<ProviderChoice>::new()));
    let import_keys = Rc::new(RefCell::new(Vec::<KeyInfo>::new()));

    // Clones for callback closure
    let (conflicts_cb, replacements_cb, removals_cb, providers_cb, import_keys_cb) = (
        Rc::clone(&conflicts),
        Rc::clone(&replacements),
        Rc::clone(&removals),
        Rc::clone(&providers),
        Rc::clone(&import_keys),
    );

    handle.set_question_cb((), move |mut question: AnyQuestion, _: &mut ()| {
        match question.question() {
            Question::Conflict(q) => {
                conflicts_cb.borrow_mut().push(ConflictInfo {
                    package1: q.conflict().package1().name().to_string(),
                    package2: q.conflict().package2().name().to_string(),
                });
                // Answer true to continue collecting more issues
                question.set_answer(true);
            }
            Question::Corrupted(_) => {
                // Never allow corrupted packages
                question.set_answer(false);
            }
            Question::RemovePkgs(q) => {
                let pkgs: Vec<String> = q.packages().iter().map(|p| p.name().to_string()).collect();
                removals_cb.borrow_mut().extend(pkgs);
                question.set_answer(true);
            }
            Question::Replace(q) => {
                replacements_cb.borrow_mut().push(ReplacementInfo {
                    old_package: q.oldpkg().name().to_string(),
                    new_package: q.newpkg().name().to_string(),
                });
                question.set_answer(true);
            }
            Question::InstallIgnorepkg(_) => {
                question.set_answer(false);
            }
            Question::SelectProvider(mut q) => {
                let provider_list: Vec<String> =
                    q.providers().iter().map(|p| p.name().to_string()).collect();
                providers_cb.borrow_mut().push(ProviderChoice {
                    dependency: q.depend().name().to_string(),
                    providers: provider_list,
                });
                // Select first provider to continue (this is just for preflight)
                q.set_index(0);
            }
            Question::ImportKey(q) => {
                import_keys_cb.borrow_mut().push(KeyInfo {
                    fingerprint: q.fingerprint().to_string(),
                    uid: q.uid().to_string(),
                });
                // Answer true to continue collecting
                question.set_answer(true);
            }
        }
    });

    // Initialize transaction
    if let Err(e) = handle.trans_init(TransFlag::NONE) {
        let response = PreflightResponse {
            error: Some(format!("Failed to initialize transaction: {}", e)),
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    // Mark packages for system upgrade
    if let Err(e) = handle.sync_sysupgrade(false) {
        let _ = handle.trans_release();
        let response = PreflightResponse {
            error: Some(format!("Failed to prepare system upgrade: {}", e)),
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    // Prepare the transaction (this triggers question callbacks)
    let prepare_success = handle.trans_prepare().is_ok();

    // Get package counts before releasing
    let packages_to_upgrade = handle.trans_add().len();
    let total_download_size: i64 = handle.trans_add().iter().map(|p| p.download_size()).sum();

    // Release the transaction (we're just doing preflight)
    let _ = handle.trans_release();

    // Check if prepare failed
    if !prepare_success {
        let response = PreflightResponse {
            error: Some("Failed to prepare transaction".to_string()),
            conflicts: conflicts.borrow().clone(),
            replacements: replacements.borrow().clone(),
            removals: removals.borrow().clone(),
            providers: providers.borrow().clone(),
            import_keys: import_keys.borrow().clone(),
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    // Check if there's anything to do
    if packages_to_upgrade == 0 {
        let response = PreflightResponse {
            success: true,
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    // Return collected issues
    let response = PreflightResponse {
        success: true,
        error: None,
        conflicts: conflicts.borrow().clone(),
        replacements: replacements.borrow().clone(),
        removals: removals.borrow().clone(),
        providers: providers.borrow().clone(),
        import_keys: import_keys.borrow().clone(),
        packages_to_upgrade,
        total_download_size,
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn sync_database(force: bool) -> Result<()> {
    setup_signal_handler();

    // Check for cancellation before starting
    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled".to_string()),
        });
        return Ok(());
    }

    let mut handle = get_handle()?;
    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle);

    match handle.syncdbs_mut().update(force) {
        Ok(_) => {
            if is_cancelled() {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
            } else {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    message: None,
                });
            }
            Ok(())
        }
        Err(e) => {
            if is_cancelled() {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
                Ok(())
            } else {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(e.to_string()),
                });
                Err(e.into())
            }
        }
    }
}

fn run_upgrade(ignore_pkgs: &[String]) -> Result<()> {
    setup_signal_handler();

    let mut handle = get_handle()?;

    // Set ignored packages - fail fast if any are invalid
    for pkg_name in ignore_pkgs {
        handle.add_ignorepkg(pkg_name.as_str()).inspect_err(|e| {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!("Failed to ignore package {}: {}", pkg_name, e)),
            });
        })?;
    }

    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle);

    // Progress callback
    handle.set_progress_cb(
        (),
        |progress: Progress,
         pkgname: &str,
         percent: i32,
         howmany: usize,
         current: usize,
         _: &mut ()| {
            if is_cancelled() {
                return; // Stop emitting events if cancelled
            }
            emit_event(&StreamEvent::Progress {
                operation: progress_to_string(progress).to_string(),
                package: pkgname.to_string(),
                percent,
                current,
                total: howmany,
            });
        },
    );

    handle.set_event_cb((), |event: AnyEvent, _: &mut ()| {
        let (event_str, pkg_name) = match event.event() {
            Event::PackageOperationStart(op) | Event::PackageOperationDone(op) => {
                let (op_name, pkg_name) = match op.operation() {
                    PackageOperation::Install(pkg) => ("install", pkg.name().to_string()),
                    PackageOperation::Upgrade(old, _new) => ("upgrade", old.name().to_string()),
                    PackageOperation::Reinstall(pkg, _) => ("reinstall", pkg.name().to_string()),
                    PackageOperation::Downgrade(old, _new) => ("downgrade", old.name().to_string()),
                    PackageOperation::Remove(pkg) => ("remove", pkg.name().to_string()),
                };
                (op_name.to_string(), Some(pkg_name))
            }
            Event::ScriptletInfo(info) => ("scriptlet".to_string(), Some(info.line().to_string())),
            Event::DatabaseMissing(db) => ("db_missing".to_string(), Some(db.dbname().to_string())),
            Event::RetrieveStart => ("retrieve_start".to_string(), None),
            Event::RetrieveDone => ("retrieve_done".to_string(), None),
            Event::RetrieveFailed => ("retrieve_failed".to_string(), None),
            Event::TransactionStart => ("transaction_start".to_string(), None),
            Event::TransactionDone => ("transaction_done".to_string(), None),
            Event::HookStart(_) => ("hook_start".to_string(), None),
            Event::HookDone(_) => ("hook_done".to_string(), None),
            Event::HookRunStart(h) => ("hook_run_start".to_string(), Some(h.name().to_string())),
            Event::HookRunDone(h) => ("hook_run_done".to_string(), Some(h.name().to_string())),
            _ => ("other".to_string(), None),
        };
        emit_event(&StreamEvent::Event {
            event: event_str,
            package: pkg_name,
        });
    });

    // User confirmed these in preflight modal
    handle.set_question_cb((), |mut question: AnyQuestion, _: &mut ()| {
        match question.question() {
            Question::Conflict(q) => {
                // User confirmed conflicts in preflight modal
                let pkg1 = q.conflict().package1().name().to_string();
                let pkg2 = q.conflict().package2().name().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Resolving conflict between {} and {}", pkg1, pkg2),
                });
                question.set_answer(true);
            }
            Question::Corrupted(q) => {
                // NEVER install corrupted packages - this is not user-confirmable
                let pkg_name = q.filepath().to_string();
                emit_event(&StreamEvent::Log {
                    level: "error".to_string(),
                    message: format!("Package {} is corrupted - aborting", pkg_name),
                });
                question.set_answer(false);
            }
            Question::RemovePkgs(q) => {
                // User confirmed removals in preflight modal
                let pkgs: Vec<String> = q.packages().iter().map(|p| p.name().to_string()).collect();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Removing packages as confirmed: {}", pkgs.join(", ")),
                });
                question.set_answer(true);
            }
            Question::Replace(q) => {
                // User confirmed replacements in preflight modal
                let old_pkg = q.oldpkg().name().to_string();
                let new_pkg = q.newpkg().name().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Replacing {} with {}", old_pkg, new_pkg),
                });
                question.set_answer(true);
            }
            Question::InstallIgnorepkg(_) => {
                // Don't install ignored packages
                question.set_answer(false);
            }
            Question::SelectProvider(mut q) => {
                // Select first provider (user saw options in preflight)
                let providers: Vec<String> =
                    q.providers().iter().map(|p| p.name().to_string()).collect();
                let dep = q.depend().name().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!(
                        "Selecting {} as provider for {}",
                        providers.first().unwrap_or(&"unknown".to_string()),
                        dep
                    ),
                });
                q.set_index(0);
            }
            Question::ImportKey(q) => {
                // User confirmed key import in preflight modal
                let fingerprint = q.fingerprint().to_string();
                let uid = q.uid().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Importing PGP key {} ({})", fingerprint, uid),
                });
                question.set_answer(true);
            }
        }
    });

    // Check for cancellation before starting
    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled".to_string()),
        });
        return Ok(());
    }

    // Initialize transaction
    handle
        .trans_init(TransFlag::NONE)
        .context("Failed to initialize transaction")?;

    // Helper to release transaction and emit cancellation
    let release_on_cancel = |handle: &mut Alpm| {
        let _ = handle.trans_release();
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled by user".to_string()),
        });
    };

    // Check for cancellation after init
    if is_cancelled() {
        release_on_cancel(&mut handle);
        return Ok(());
    }

    // Mark packages for system upgrade
    if let Err(e) = handle.sync_sysupgrade(false) {
        let _ = handle.trans_release();
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!("Failed to prepare system upgrade: {}", e)),
        });
        return Err(e.into());
    }

    // Check for cancellation before prepare
    if is_cancelled() {
        release_on_cancel(&mut handle);
        return Ok(());
    }

    // Prepare transaction (resolve dependencies)
    let prepare_err: Option<String> = handle.trans_prepare().err().map(|e| e.to_string());
    if let Some(err_msg) = prepare_err {
        let _ = handle.trans_release();
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!("Failed to prepare transaction: {}", err_msg)),
        });
        return Err(anyhow::anyhow!(
            "Failed to prepare transaction: {}",
            err_msg
        ));
    }

    // Check if there's anything to do
    if handle.trans_add().is_empty() && handle.trans_remove().is_empty() {
        let _ = handle.trans_release();
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some("System is up to date".to_string()),
        });
        return Ok(());
    }

    // Commit
    let commit_err: Option<String> = handle.trans_commit().err().map(|e| e.to_string());
    if let Some(err_msg) = commit_err {
        let _ = handle.trans_release();
        // Check if this was due to cancellation
        if is_cancelled() {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(
                    "Operation interrupted - system may be in inconsistent state".to_string(),
                ),
            });
        } else {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!("Failed to commit transaction: {}", err_msg)),
            });
        }
        return Err(anyhow::anyhow!("Failed to commit transaction: {}", err_msg));
    }

    // Release the transaction
    let _ = handle.trans_release();

    emit_event(&StreamEvent::Complete {
        success: true,
        message: None,
    });

    Ok(())
}

fn local_package_info(name: &str) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();

    let pkg = localdb
        .pkg(name)
        .map_err(|_| anyhow::anyhow!("Package '{}' not found", name))?;

    let repository = find_package_repo(&handle, name);

    let details = PackageDetails {
        name: pkg.name().to_string(),
        version: pkg.version().to_string(),
        description: pkg.desc().map(|s| s.to_string()),
        url: pkg.url().map(|s| s.to_string()),
        licenses: pkg.licenses().iter().map(|s| s.to_string()).collect(),
        groups: pkg.groups().iter().map(|s| s.to_string()).collect(),
        provides: pkg
            .provides()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        depends: pkg.depends().iter().map(|d| d.name().to_string()).collect(),
        optdepends: pkg
            .optdepends()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        conflicts: pkg
            .conflicts()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        replaces: pkg
            .replaces()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        installed_size: pkg.isize(),
        packager: pkg.packager().map(|s| s.to_string()),
        architecture: pkg.arch().map(|s| s.to_string()),
        build_date: pkg.build_date(),
        install_date: pkg.install_date(),
        reason: reason_to_string(pkg.reason()).to_string(),
        validation: pkg
            .validation()
            .iter()
            .map(|v| format!("{:?}", v))
            .collect(),
        repository,
    };

    println!("{}", serde_json::to_string(&details)?);
    Ok(())
}

#[derive(Serialize)]
struct SearchResponse {
    results: Vec<SearchResult>,
    total: usize,
    total_installed: usize,
    total_not_installed: usize,
    repositories: Vec<String>,
}

fn search(
    query: &str,
    offset: usize,
    limit: usize,
    installed_filter: Option<bool>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let mut repo_set: HashSet<String> = HashSet::new();
    let query_lower = query.to_lowercase();

    // First pass: collect all matching packages and count by installed status
    let mut total_installed = 0usize;
    let mut total_not_installed = 0usize;
    let mut all_matches: Vec<SearchResult> = Vec::new();

    for syncdb in handle.syncdbs() {
        for pkg in syncdb.pkgs() {
            let name_match = pkg.name().to_lowercase().contains(&query_lower);
            let desc_match = pkg
                .desc()
                .map(|d| d.to_lowercase().contains(&query_lower))
                .unwrap_or(false);

            if name_match || desc_match {
                let repo_name = syncdb.name().to_string();
                repo_set.insert(repo_name.clone());
                let local_pkg = localdb.pkg(pkg.name()).ok();
                let is_installed = local_pkg.is_some();

                if is_installed {
                    total_installed += 1;
                } else {
                    total_not_installed += 1;
                }

                all_matches.push(SearchResult {
                    name: pkg.name().to_string(),
                    version: pkg.version().to_string(),
                    description: pkg.desc().map(|s| s.to_string()),
                    repository: repo_name,
                    installed: is_installed,
                    installed_version: local_pkg.map(|p| p.version().to_string()),
                });
            }
        }
    }

    // Second pass: apply installed filter
    let mut filtered: Vec<SearchResult> = if let Some(filter) = installed_filter {
        all_matches
            .into_iter()
            .filter(|r| r.installed == filter)
            .collect()
    } else {
        all_matches
    };

    // Sort before pagination
    let ascending = sort_dir != Some("desc");
    match sort_by {
        Some("name") => {
            filtered.sort_by(|a, b| {
                let cmp = a.name.cmp(&b.name);
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        Some("repository") => {
            filtered.sort_by(|a, b| {
                let cmp = a.repository.cmp(&b.repository);
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        Some("status") => {
            filtered.sort_by(|a, b| {
                let cmp = a.installed.cmp(&b.installed);
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        _ => {} // No sorting or unknown column
    }

    let total = filtered.len();
    let results: Vec<SearchResult> = filtered.into_iter().skip(offset).take(limit).collect();
    let mut repositories: Vec<String> = repo_set.into_iter().collect();
    repositories.sort();

    let response = SearchResponse {
        results,
        total,
        total_installed,
        total_not_installed,
        repositories,
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

#[derive(Serialize)]
struct SyncPackageDetails {
    name: String,
    version: String,
    description: Option<String>,
    url: Option<String>,
    licenses: Vec<String>,
    groups: Vec<String>,
    provides: Vec<String>,
    depends: Vec<String>,
    optdepends: Vec<String>,
    conflicts: Vec<String>,
    replaces: Vec<String>,
    download_size: i64,
    installed_size: i64,
    packager: Option<String>,
    architecture: Option<String>,
    build_date: i64,
    repository: String,
}

fn sync_package_info(name: &str, repo: Option<&str>) -> Result<()> {
    let handle = get_handle()?;

    // If repo specified, search only that repo; otherwise search all
    let pkg_result = if let Some(repo_name) = repo {
        handle
            .syncdbs()
            .iter()
            .find(|db| db.name() == repo_name)
            .and_then(|db| db.pkg(name).ok())
            .map(|pkg| (pkg, repo_name.to_string()))
    } else {
        handle
            .syncdbs()
            .iter()
            .find_map(|db| db.pkg(name).ok().map(|pkg| (pkg, db.name().to_string())))
    };

    let (pkg, repository) = pkg_result
        .ok_or_else(|| anyhow::anyhow!("Package '{}' not found in sync databases", name))?;

    let details = SyncPackageDetails {
        name: pkg.name().to_string(),
        version: pkg.version().to_string(),
        description: pkg.desc().map(|s| s.to_string()),
        url: pkg.url().map(|s| s.to_string()),
        licenses: pkg.licenses().iter().map(|s| s.to_string()).collect(),
        groups: pkg.groups().iter().map(|s| s.to_string()).collect(),
        provides: pkg
            .provides()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        depends: pkg.depends().iter().map(|d| d.name().to_string()).collect(),
        optdepends: pkg
            .optdepends()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        conflicts: pkg
            .conflicts()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        replaces: pkg
            .replaces()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        download_size: pkg.download_size(),
        installed_size: pkg.isize(),
        packager: pkg.packager().map(|s| s.to_string()),
        architecture: pkg.arch().map(|s| s.to_string()),
        build_date: pkg.build_date(),
        repository,
    };

    println!("{}", serde_json::to_string(&details)?);
    Ok(())
}

fn print_usage() {
    eprintln!("Usage: cockpit-pacman-backend <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  list-installed [offset] [limit] [search] [filter] [repo] [sort_by] [sort_dir]");
    eprintln!("                         List installed packages (paginated)");
    eprintln!("                         filter: all|explicit|dependency");
    eprintln!("                         repo: all|core|extra|multilib|user|...");
    eprintln!("                         sort_by: name|size|reason");
    eprintln!("                         sort_dir: asc|desc");
    eprintln!("  check-updates          Check for available updates");
    eprintln!("  preflight-upgrade [ignore]");
    eprintln!("                         Check what the upgrade will do (requires root)");
    eprintln!("                         ignore: comma-separated list of packages to skip");
    eprintln!("                         Returns conflicts, replacements, keys to import");
    eprintln!("  sync-database [force]  Sync package databases (requires root)");
    eprintln!("                         force: true|false (default: true)");
    eprintln!("  upgrade [ignore]       Perform system upgrade (requires root)");
    eprintln!("                         ignore: comma-separated list of packages to skip");
    eprintln!("  local-package-info NAME");
    eprintln!("                         Get detailed info for an installed package");
    eprintln!("  sync-package-info NAME [REPO]");
    eprintln!("                         Get detailed info for a package from sync databases");
    eprintln!("  search QUERY [offset] [limit] [installed] [sort_by] [sort_dir]");
    eprintln!("                         Search packages by name/description (paginated)");
    eprintln!("                         installed: all|installed|not-installed");
    eprintln!("                         sort_by: name|repository|status");
    eprintln!("                         sort_dir: asc|desc");
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "list-installed" => {
            let offset = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(50);
            let search = args.get(4).map(|s| s.as_str()).filter(|s| !s.is_empty());
            let filter = args
                .get(5)
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty() && *s != "all");
            let repo_filter = args
                .get(6)
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty() && *s != "all");
            let sort_by = args.get(7).map(|s| s.as_str()).filter(|s| !s.is_empty());
            let sort_dir = args.get(8).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_pagination(offset, limit).and_then(|_| {
                list_installed(
                    offset,
                    limit,
                    search,
                    filter,
                    repo_filter,
                    sort_by,
                    sort_dir,
                )
            })
        }
        "check-updates" => check_updates(),
        "preflight-upgrade" => {
            // Parse comma-separated list of packages to ignore
            let ignore_pkgs: Vec<String> = args
                .get(2)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            preflight_upgrade(&ignore_pkgs)
        }
        "sync-database" => {
            let force = args.get(2).map(|s| s == "true").unwrap_or(true);
            sync_database(force)
        }
        "upgrade" => {
            // Parse comma-separated list of packages to ignore
            let ignore_pkgs: Vec<String> = args
                .get(2)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            run_upgrade(&ignore_pkgs)
        }
        "local-package-info" => {
            if args.len() < 3 {
                eprintln!("Error: local-package-info requires a package name");
                std::process::exit(1);
            }
            validate_package_name(&args[2]).and_then(|_| local_package_info(&args[2]))
        }
        "search" => {
            if args.len() < 3 {
                eprintln!("Error: search requires a query");
                std::process::exit(1);
            }
            let offset = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(100);
            let installed_filter = args.get(5).and_then(|s| match s.as_str() {
                "installed" => Some(true),
                "not-installed" => Some(false),
                _ => None,
            });
            let sort_by = args.get(6).map(|s| s.as_str()).filter(|s| !s.is_empty());
            let sort_dir = args.get(7).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_search_query(&args[2])
                .and_then(|_| validate_pagination(offset, limit))
                .and_then(|_| search(&args[2], offset, limit, installed_filter, sort_by, sort_dir))
        }
        "sync-package-info" => {
            if args.len() < 3 {
                eprintln!("Error: sync-package-info requires a package name");
                std::process::exit(1);
            }
            let repo = args.get(3).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_package_name(&args[2]).and_then(|_| sync_package_info(&args[2], repo))
        }
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        cmd => {
            eprintln!("Error: unknown command '{}'", cmd);
            print_usage();
            std::process::exit(1);
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {:#}", e);
        std::process::exit(1);
    }
}
