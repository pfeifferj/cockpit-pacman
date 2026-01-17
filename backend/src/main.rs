use alpm::{
    Alpm, AnyDownloadEvent, AnyEvent, AnyQuestion, DownloadEvent, Event, LogLevel,
    PackageOperation, Progress, Question, TransFlag,
};
use alpm_utils::{alpm_with_conf, DbListExt};
use anyhow::{Context, Result};
use pacman_key::{
    CancellationToken, InitializationStatus, KeyValidity, Keyring, OperationOptions,
    RefreshProgress,
};
use pacmanconf::Config;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
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

    if HANDLER_SET.load(Ordering::SeqCst) {
        return;
    }

    match ctrlc::set_handler(move || {
        CANCELLED.store(true, Ordering::SeqCst);
    }) {
        Ok(()) => {
            HANDLER_SET.store(true, Ordering::SeqCst);
        }
        Err(e) => {
            eprintln!("Warning: Failed to set signal handler: {}", e);
        }
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

#[derive(Default)]
struct PreflightState {
    conflicts: Vec<ConflictInfo>,
    replacements: Vec<ReplacementInfo>,
    removals: Vec<String>,
    providers: Vec<ProviderChoice>,
    import_keys: Vec<KeyInfo>,
}

fn emit_event(event: &StreamEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        println!("{}", json);
        let _ = io::stdout().flush();
    }
}

struct TransactionGuard<'a> {
    handle: &'a mut Alpm,
    released: bool,
}

impl<'a> TransactionGuard<'a> {
    fn new(handle: &'a mut Alpm, flags: TransFlag) -> Result<Self> {
        handle
            .trans_init(flags)
            .context("Failed to initialize transaction")?;
        Ok(Self {
            handle,
            released: false,
        })
    }

    fn sync_sysupgrade(&mut self, enable_downgrade: bool) -> Result<(), alpm::Error> {
        self.handle.sync_sysupgrade(enable_downgrade)
    }

    fn prepare(&mut self) -> Result<(), alpm::PrepareError<'_>> {
        self.handle.trans_prepare()
    }

    fn commit(&mut self) -> Result<(), alpm::CommitError> {
        self.handle.trans_commit()
    }

    fn add(&self) -> alpm::AlpmList<'_, &alpm::Package> {
        self.handle.trans_add()
    }

    fn remove(&self) -> alpm::AlpmList<'_, &alpm::Package> {
        self.handle.trans_remove()
    }
}

impl Drop for TransactionGuard<'_> {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.handle.trans_release();
        }
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

fn validity_to_string(v: &KeyValidity) -> &'static str {
    match v {
        KeyValidity::Unknown => "unknown",
        KeyValidity::Undefined => "undefined",
        KeyValidity::Never => "never",
        KeyValidity::Marginal => "marginal",
        KeyValidity::Full => "full",
        KeyValidity::Ultimate => "ultimate",
        KeyValidity::Expired => "expired",
        KeyValidity::Revoked => "revoked",
        _ => "unknown",
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

fn build_repo_map(handle: &Alpm) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for db in handle.syncdbs() {
        let repo_name = db.name().to_string();
        for pkg in db.pkgs() {
            map.insert(pkg.name().to_string(), repo_name.clone());
        }
    }
    map
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
    let repo_map = build_repo_map(&handle);

    let search_lower = search.map(|s| s.to_lowercase());
    let filter_reason = filter.and_then(|f| match f {
        "explicit" => Some(alpm::PackageReason::Explicit),
        "dependency" => Some(alpm::PackageReason::Depend),
        _ => None,
    });

    // Single pass: collect repos, apply filters, count by reason
    let (mut filtered, repo_set, total_explicit, total_dependency) = localdb.pkgs().iter().fold(
        (Vec::new(), HashSet::<String>::new(), 0usize, 0usize),
        |(mut filtered, mut repo_set, mut total_explicit, mut total_dependency), pkg| {
            let repo = repo_map.get(pkg.name()).cloned();
            repo_set.insert(repo.as_deref().unwrap_or("user").to_string());

            // Apply search filter
            if let Some(ref query) = search_lower {
                let name_match = pkg.name().to_lowercase().contains(query);
                let desc_match = pkg
                    .desc()
                    .map(|d| d.to_lowercase().contains(query))
                    .unwrap_or(false);
                if !name_match && !desc_match {
                    return (filtered, repo_set, total_explicit, total_dependency);
                }
            }

            // Apply repo filter
            if let Some(repo_f) = repo_filter {
                if repo.as_deref().unwrap_or("user") != repo_f {
                    return (filtered, repo_set, total_explicit, total_dependency);
                }
            }

            // Count by reason (after search/repo filter, before reason filter)
            match pkg.reason() {
                alpm::PackageReason::Explicit => total_explicit += 1,
                alpm::PackageReason::Depend => total_dependency += 1,
            }

            // Apply reason filter
            if filter_reason.is_none() || pkg.reason() == filter_reason.unwrap() {
                filtered.push((pkg, repo));
            }

            (filtered, repo_set, total_explicit, total_dependency)
        },
    );

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
        _ => {} // Keep default order
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
    let state = Rc::new(RefCell::new(PreflightState::default()));
    let state_cb = Rc::clone(&state);

    handle.set_question_cb(
        (),
        move |mut question: AnyQuestion, _: &mut ()| match question.question() {
            Question::Conflict(q) => {
                state_cb.borrow_mut().conflicts.push(ConflictInfo {
                    package1: q.conflict().package1().name().to_string(),
                    package2: q.conflict().package2().name().to_string(),
                });
                question.set_answer(true);
            }
            Question::Corrupted(_) => {
                question.set_answer(false);
            }
            Question::RemovePkgs(q) => {
                let pkgs: Vec<String> = q.packages().iter().map(|p| p.name().to_string()).collect();
                state_cb.borrow_mut().removals.extend(pkgs);
                question.set_answer(true);
            }
            Question::Replace(q) => {
                state_cb.borrow_mut().replacements.push(ReplacementInfo {
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
                state_cb.borrow_mut().providers.push(ProviderChoice {
                    dependency: q.depend().name().to_string(),
                    providers: provider_list,
                });
                q.set_index(0);
            }
            Question::ImportKey(q) => {
                state_cb.borrow_mut().import_keys.push(KeyInfo {
                    fingerprint: q.fingerprint().to_string(),
                    uid: q.uid().to_string(),
                });
                question.set_answer(true);
            }
        },
    );

    // Initialize transaction (guard releases on drop)
    let mut tx = match TransactionGuard::new(&mut handle, TransFlag::NONE) {
        Ok(tx) => tx,
        Err(e) => {
            let response = PreflightResponse {
                error: Some(format!("{}", e)),
                ..Default::default()
            };
            println!("{}", serde_json::to_string(&response)?);
            return Ok(());
        }
    };

    // Mark packages for system upgrade
    if let Err(e) = tx.sync_sysupgrade(false) {
        let response = PreflightResponse {
            error: Some(format!("Failed to prepare system upgrade: {}", e)),
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    // Prepare the transaction (this triggers question callbacks)
    let prepare_success = tx.prepare().is_ok();

    // Get package counts before guard is dropped
    let packages_to_upgrade = tx.add().len();
    let total_download_size: i64 = tx.add().iter().map(|p| p.download_size()).sum();

    // Guard releases transaction on drop

    // Check if prepare failed
    if !prepare_success {
        let s = state.borrow();
        let response = PreflightResponse {
            error: Some("Failed to prepare transaction".to_string()),
            conflicts: s.conflicts.clone(),
            replacements: s.replacements.clone(),
            removals: s.removals.clone(),
            providers: s.providers.clone(),
            import_keys: s.import_keys.clone(),
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
    let s = state.borrow();
    let response = PreflightResponse {
        success: true,
        error: None,
        conflicts: s.conflicts.clone(),
        replacements: s.replacements.clone(),
        removals: s.removals.clone(),
        providers: s.providers.clone(),
        import_keys: s.import_keys.clone(),
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

    // Set ignored packages
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

    // Initialize transaction (guard releases on drop)
    let mut tx = TransactionGuard::new(&mut handle, TransFlag::NONE)?;

    // Check for cancellation after init
    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled by user".to_string()),
        });
        return Ok(());
    }

    // Mark packages for system upgrade
    if let Err(e) = tx.sync_sysupgrade(false) {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!("Failed to prepare system upgrade: {}", e)),
        });
        return Err(e.into());
    }

    // Check for cancellation before prepare
    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled by user".to_string()),
        });
        return Ok(());
    }

    // Prepare transaction (resolve dependencies)
    let prepare_err: Option<String> = tx.prepare().err().map(|e| e.to_string());
    if let Some(err_msg) = prepare_err {
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
    if tx.add().is_empty() && tx.remove().is_empty() {
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some("System is up to date".to_string()),
        });
        return Ok(());
    }

    // Commit
    let was_cancelled_before = is_cancelled();
    let commit_err: Option<String> = tx.commit().err().map(|e| e.to_string());
    if let Some(err_msg) = commit_err {
        let cancelled_during = !was_cancelled_before && is_cancelled();
        let err_lower = err_msg.to_lowercase();
        let error_indicates_interrupt = err_lower.contains("interrupt")
            || err_lower.contains("cancel")
            || err_lower.contains("signal");

        if cancelled_during || error_indicates_interrupt {
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

    // Guard releases transaction on drop
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

#[derive(Serialize)]
struct KeyringKey {
    fingerprint: String,
    uid: String,
    created: Option<String>,
    expires: Option<String>,
    trust: String,
}

#[derive(Serialize)]
struct KeyringStatusResponse {
    keys: Vec<KeyringKey>,
    total: usize,
    master_key_initialized: bool,
    warnings: Vec<String>,
}

fn keyring_status() -> Result<()> {
    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        let mut warnings: Vec<String> = Vec::new();
        let keyring = Keyring::new();

        let master_key_initialized = match keyring.is_initialized() {
            Ok(InitializationStatus::Ready) => true,
            Ok(InitializationStatus::DirectoryMissing) => {
                warnings.push(
                    "Keyring not initialized. Run 'pacman-key --init' to initialize.".to_string(),
                );
                false
            }
            Ok(InitializationStatus::PathIsSymlink) => {
                warnings.push(
                    "Security warning: keyring path is a symlink. This may be unsafe.".to_string(),
                );
                false
            }
            Ok(InitializationStatus::IncorrectPermissions { actual }) => {
                warnings.push(format!(
                    "Keyring directory has incorrect permissions: {:o} (expected 700)",
                    actual
                ));
                true
            }
            Ok(InitializationStatus::NoKeyringFiles) => {
                warnings.push("Keyring directory exists but contains no keys.".to_string());
                false
            }
            Ok(InitializationStatus::NoTrustDb) => {
                warnings.push("Keyring missing trust database.".to_string());
                false
            }
            Ok(status) => {
                warnings.push(format!("Keyring status: {:?}", status));
                false
            }
            Err(e) => {
                warnings.push(format!("Failed to check keyring status: {}", e));
                false
            }
        };

        let keys: Vec<KeyringKey> = if master_key_initialized {
            match keyring.list_keys().await {
                Ok(key_list) => key_list
                    .into_iter()
                    .map(|k| KeyringKey {
                        fingerprint: k.fingerprint,
                        uid: k.uid,
                        created: k.created.map(|d| d.format("%Y-%m-%d").to_string()),
                        expires: k.expires.map(|d| d.format("%Y-%m-%d").to_string()),
                        trust: validity_to_string(&k.validity).to_string(),
                    })
                    .collect(),
                Err(e) => {
                    warnings.push(format!("Failed to list keys: {}", e));
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        let response = KeyringStatusResponse {
            total: keys.len(),
            keys,
            master_key_initialized,
            warnings,
        };

        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    })
}

fn refresh_keyring() -> Result<()> {
    setup_signal_handler();

    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled".to_string()),
        });
        return Ok(());
    }

    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        emit_event(&StreamEvent::Log {
            level: "info".to_string(),
            message: "Refreshing pacman keyring...".to_string(),
        });

        let keyring = Keyring::new();
        let cancel_token = CancellationToken::new();
        let cancel_token_clone = cancel_token.clone();

        // Spawn task to watch for SIGINT and trigger cancellation
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if is_cancelled() {
                    cancel_token_clone.cancel();
                    break;
                }
            }
        });

        let options = OperationOptions {
            timeout_secs: Some(600), // 10 minute timeout for key refresh
            cancel_token: Some(cancel_token),
        };

        let callback = |progress: RefreshProgress| match progress {
            RefreshProgress::Starting { total_keys } => {
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Starting refresh of {} keys", total_keys),
                });
            }
            RefreshProgress::Refreshing {
                current,
                total,
                keyid,
            } => {
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Refreshing key {}/{}: {}", current, total, keyid),
                });
            }
            RefreshProgress::Completed => {
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: "Key refresh completed".to_string(),
                });
            }
            RefreshProgress::Error { keyid, message } => {
                emit_event(&StreamEvent::Log {
                    level: "warning".to_string(),
                    message: format!("Error refreshing key {}: {}", keyid, message),
                });
            }
            _ => {}
        };

        match keyring.refresh_keys(callback, options).await {
            Ok(()) => {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    message: Some("Keyring refresh completed".to_string()),
                });
            }
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Operation timed out after {} seconds", secs)),
                });
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Keyring refresh failed: {}", e)),
                });
            }
        }
        Ok(())
    })
}

fn init_keyring() -> Result<()> {
    setup_signal_handler();

    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled".to_string()),
        });
        return Ok(());
    }

    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        emit_event(&StreamEvent::Log {
            level: "info".to_string(),
            message: "Initializing pacman keyring...".to_string(),
        });

        let keyring = Keyring::new();
        let cancel_token = CancellationToken::new();
        let cancel_token_clone = cancel_token.clone();

        // Spawn task to watch for SIGINT and trigger cancellation
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if is_cancelled() {
                    cancel_token_clone.cancel();
                    break;
                }
            }
        });

        let options = OperationOptions {
            timeout_secs: Some(120), // 2 minute timeout for init
            cancel_token: Some(cancel_token.clone()),
        };

        match keyring.init_keyring_with_options(options).await {
            Ok(()) => {}
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
                return Ok(());
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Init timed out after {} seconds", secs)),
                });
                return Ok(());
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Failed to initialize keyring: {}", e)),
                });
                return Ok(());
            }
        }

        emit_event(&StreamEvent::Log {
            level: "info".to_string(),
            message: "Populating keyring with Arch Linux keys...".to_string(),
        });

        let populate_options = OperationOptions {
            timeout_secs: Some(300), // 5 minute timeout for populate
            cancel_token: Some(cancel_token),
        };

        match keyring
            .populate_with_options(&["archlinux"], populate_options)
            .await
        {
            Ok(()) => {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    message: Some("Keyring initialized and populated".to_string()),
                });
            }
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Populate timed out after {} seconds", secs)),
                });
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Failed to populate keyring: {}", e)),
                });
            }
        }
        Ok(())
    })
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
    eprintln!("  keyring-status         Get pacman keyring status and list keys");
    eprintln!("  refresh-keyring        Refresh keys from keyserver (requires root)");
    eprintln!("  init-keyring           Initialize and populate keyring (requires root)");
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
        "keyring-status" => keyring_status(),
        "refresh-keyring" => refresh_keyring(),
        "init-keyring" => init_keyring(),
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
