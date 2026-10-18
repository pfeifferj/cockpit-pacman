use alpm::{Alpm, AnyEvent, AnyQuestion, Event, PackageOperation, Progress, Question, TransFlag};
use anyhow::Result;
use std::cell::RefCell;
use std::rc::Rc;

use crate::alpm::{
    SysupgradeOutcome, TransactionGuard, Verbosity, get_handle, progress_to_string, run_sysupgrade,
    setup_dl_cb, setup_log_cb,
};
use crate::check_cancel_early;
use crate::db::invalidate_repo_map_cache;
use crate::inhibit::ShutdownInhibitor;
use crate::models::{
    AddReason, ConflictInfo, KeyInfo, PreflightResponse, PreflightState, PreflightWarning,
    PreviewAdd, PreviewRemove, ProviderChoice, RemoveReason, ReplacementInfo, StreamEvent,
    TransactionPreview, WarningSeverity, preview_totals,
};
use crate::util::{
    CheckResult, DEFAULT_MUTATION_TIMEOUT_SECS, TimeoutGuard, check_cancel,
    emit_cancellation_complete, emit_event, emit_failure, emit_json, handle_commit_error,
    is_cancelled, setup_signal_handler, spawn_cancel_listener,
};

pub(crate) const KERNEL_PACKAGES: &[&str] = &[
    "linux",
    "linux-lts",
    "linux-zen",
    "linux-hardened",
    "linux-rt",
    "linux-rt-lts",
];

fn is_kernel_package(
    name: &str,
    mut provides_names: impl Iterator<Item = impl AsRef<str>>,
) -> bool {
    KERNEL_PACKAGES.contains(&name) || provides_names.any(|p| p.as_ref() == "linux")
}

/// Which package operations and informational events a mutation streams.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum EventScope {
    Upgrade,
    Install,
    Remove,
}

impl EventScope {
    fn maps_installs(self) -> bool {
        matches!(self, EventScope::Upgrade | EventScope::Install)
    }

    fn verbose(self) -> bool {
        matches!(self, EventScope::Upgrade | EventScope::Install)
    }
}

pub(crate) fn setup_progress_cb(handle: &mut Alpm) {
    let mut last: Option<(&'static str, String, i32, usize, usize)> = None;

    handle.set_progress_cb(
        (),
        move |progress: Progress,
              pkgname: &str,
              percent: i32,
              howmany: usize,
              current: usize,
              _: &mut ()| {
            let operation = progress_to_string(progress);
            if last.as_ref().is_some_and(|(op, pkg, pct, cur, total)| {
                *op == operation
                    && pkg == pkgname
                    && *pct == percent
                    && *cur == current
                    && *total == howmany
            }) {
                return;
            }

            emit_event(&StreamEvent::Progress {
                operation: operation.to_string(),
                package: pkgname.to_string(),
                percent,
                current,
                total: howmany,
            });
            last = Some((operation, pkgname.to_string(), percent, current, howmany));
        },
    );
}

fn hook_position(position: usize, total: usize) -> Option<(usize, usize)> {
    (total > 0).then_some((position, total))
}

pub(crate) fn setup_event_cb(handle: &mut Alpm, scope: EventScope) {
    handle.set_event_cb((), move |event: AnyEvent, _: &mut ()| {
        let (event_str, pkg_name, position) = match event.event() {
            Event::PackageOperationStart(op) | Event::PackageOperationDone(op) => {
                let (op_name, pkg_name) = match op.operation() {
                    PackageOperation::Install(pkg) if scope.maps_installs() => {
                        ("install", pkg.name().to_string())
                    }
                    PackageOperation::Upgrade(old, _new) if scope.maps_installs() => {
                        ("upgrade", old.name().to_string())
                    }
                    PackageOperation::Reinstall(pkg, _) if scope.maps_installs() => {
                        ("reinstall", pkg.name().to_string())
                    }
                    PackageOperation::Downgrade(old, _new) if scope == EventScope::Upgrade => {
                        ("downgrade", old.name().to_string())
                    }
                    PackageOperation::Remove(pkg) if scope != EventScope::Install => {
                        ("remove", pkg.name().to_string())
                    }
                    _ => return,
                };
                (op_name.to_string(), Some(pkg_name), None)
            }
            Event::ScriptletInfo(info) if scope.verbose() => {
                ("scriptlet".to_string(), Some(info.line().to_string()), None)
            }
            Event::DatabaseMissing(db) if scope.verbose() => (
                "db_missing".to_string(),
                Some(db.dbname().to_string()),
                None,
            ),
            Event::RetrieveStart if scope.verbose() => ("retrieve_start".to_string(), None, None),
            Event::RetrieveDone if scope.verbose() => ("retrieve_done".to_string(), None, None),
            Event::RetrieveFailed if scope.verbose() => ("retrieve_failed".to_string(), None, None),
            Event::TransactionStart => ("transaction_start".to_string(), None, None),
            Event::TransactionDone => ("transaction_done".to_string(), None, None),
            Event::HookStart(_) => ("hook_start".to_string(), None, None),
            Event::HookDone(_) => ("hook_done".to_string(), None, None),
            Event::HookRunStart(h) => (
                "hook_run_start".to_string(),
                Some(h.name().to_string()),
                hook_position(h.position(), h.total()),
            ),
            Event::HookRunDone(h) => (
                "hook_run_done".to_string(),
                Some(h.name().to_string()),
                hook_position(h.position(), h.total()),
            ),
            _ if scope == EventScope::Upgrade => ("other".to_string(), None, None),
            _ => return,
        };
        let (current, total) = position.unzip();
        emit_event(&StreamEvent::Event {
            event: event_str,
            package: pkg_name,
            current,
            total,
        });
    });
}

/// Upgrade removals are checked against the confirmed plan after preparation.
pub(crate) fn setup_question_cb(handle: &mut Alpm, answer_remove_pkgs: bool) {
    handle.set_question_cb(
        (),
        move |mut question: AnyQuestion, _: &mut ()| match question.question() {
            Question::Conflict(q) => {
                let pkg1 = q.conflict().package1().name().to_string();
                let pkg2 = q.conflict().package2().name().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: if answer_remove_pkgs {
                        format!("Resolving conflict between {pkg1} and {pkg2}")
                    } else {
                        format!("{pkg1} conflicts with {pkg2}. Review the removal with pacman before retrying.")
                    },
                });
                question.set_answer(answer_remove_pkgs);
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
                let pkgs: Vec<String> = q.packages().iter().map(|p| p.name().to_string()).collect();
                emit_event(&StreamEvent::Log {
                    level: "error".to_string(),
                    message: format!("Packages have unresolved dependencies: {}. Resolve them before upgrading.", pkgs.join(", ")),
                });
                question.set_answer(false);
            }
            Question::Replace(q) => {
                let old_pkg = q.oldpkg().name().to_string();
                let new_pkg = q.newpkg().name().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: if answer_remove_pkgs {
                        format!("Replacing {old_pkg} with {new_pkg}")
                    } else {
                        format!("{new_pkg} would replace {old_pkg}. Review the removal with pacman before retrying.")
                    },
                });
                question.set_answer(answer_remove_pkgs);
            }
            Question::InstallIgnorepkg(_) => {
                question.set_answer(false);
            }
            Question::SelectProvider(mut q) => {
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
                let fingerprint = q.fingerprint().to_string();
                let uid = q.uid().to_string();
                emit_event(&StreamEvent::Log {
                    level: "error".to_string(),
                    message: format!("Signing key {fingerprint} ({uid}) needs verification. Import it with pacman-key after verifying its fingerprint, then retry."),
                });
                question.set_answer(false);
            }
        },
    );
}

pub(crate) struct MutationOpts {
    /// Install the question callback with this answer_remove_pkgs flag.
    pub questions: Option<bool>,
}

pub(crate) fn begin_mutation(
    scope: EventScope,
    opts: MutationOpts,
    timeout_secs: Option<u64>,
) -> Result<(Alpm, TimeoutGuard)> {
    setup_signal_handler()?;
    spawn_cancel_listener()?;
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    let mut handle = get_handle()?;
    setup_log_cb(&mut handle);
    if scope != EventScope::Remove {
        setup_dl_cb(&mut handle, Verbosity::Streaming);
    }
    setup_progress_cb(&mut handle);
    setup_event_cb(&mut handle, scope);
    if let Some(answer_remove_pkgs) = opts.questions {
        setup_question_cb(&mut handle, answer_remove_pkgs);
    }

    Ok((handle, timeout))
}

pub(crate) fn fail_complete(message: String) -> anyhow::Error {
    emit_failure(&message, "transaction_failed");
    anyhow::anyhow!(message)
}

pub(crate) fn prepare_failure(err_msg: &str) -> anyhow::Error {
    fail_complete(format!("Failed to prepare transaction: {}", err_msg))
}

pub(crate) fn add_pkg_failure(name: &str, e: impl std::fmt::Display) -> anyhow::Error {
    fail_complete(format!("Failed to add '{}' to transaction: {}", name, e))
}

pub(crate) fn commit_and_complete(
    tx: &mut TransactionGuard,
    timeout: &TimeoutGuard,
    success_msg: Option<String>,
) -> Result<()> {
    let _inhibitor = ShutdownInhibitor::take("Applying package changes");
    check_cancel_early!(timeout);
    match tx.commit() {
        Err(error) if error.is::<crate::network::NetworkError>() => Err(error),
        Err(error) => handle_commit_error(
            &error.to_string(),
            is_cancelled(),
            "Cancellation was requested while committing",
        ),
        Ok(()) => {
            emit_event(&StreamEvent::Complete {
                success: true,
                code: None,
                details: None,
                message: success_msg,
            });
            Ok(())
        }
    }
}

fn effective_ignored_packages(selected: &[String]) -> Result<Vec<String>> {
    let mut ignored = crate::config::AppConfig::load()?.ignored_packages;
    ignored.extend_from_slice(selected);
    ignored.sort();
    ignored.dedup();
    Ok(ignored)
}

/// Collects decisions needed to preview a transaction without committing.
pub(crate) fn record_questions(handle: &mut Alpm, state: &Rc<RefCell<PreflightState>>) {
    let state_cb = Rc::clone(state);
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
                state_cb.borrow_mut().declined_removals.extend(pkgs);
                question.set_answer(false);
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
                question.set_answer(false);
            }
        },
    );
}

pub fn preflight_upgrade(ignore_pkgs: &[String]) -> Result<()> {
    // Before the lock: a timeout SIGTERM must set the flag, not kill the
    // process with db.lck held.
    setup_signal_handler()?;

    let mut handle = get_handle()?;

    for pkg_name in effective_ignored_packages(ignore_pkgs)? {
        handle.add_ignorepkg(pkg_name.as_str())?;
    }

    let state = Rc::new(RefCell::new(PreflightState::default()));
    record_questions(&mut handle, &state);

    if is_cancelled() {
        anyhow::bail!("Operation cancelled");
    }

    let mut tx = match TransactionGuard::new(&mut handle, TransFlag::NONE) {
        Ok(tx) => tx,
        Err(e) => {
            let response = PreflightResponse {
                error: Some(format!("{:#}", e)),
                ..Default::default()
            };
            return emit_json(&response);
        }
    };

    if let Err(e) = tx.sync_sysupgrade(false) {
        let response = PreflightResponse {
            error: Some(format!("Failed to prepare system upgrade: {}", e)),
            ..Default::default()
        };
        return emit_json(&response);
    }

    if is_cancelled() {
        anyhow::bail!("Operation cancelled");
    }

    let prepare_err = tx.prepare().err();
    let mut removals: Vec<String> = tx
        .remove()
        .iter()
        .map(|pkg| pkg.name().to_string())
        .collect();
    removals.sort_unstable();
    removals.dedup();

    let packages_to_upgrade = tx.add().len();
    let total_download_size: i64 = tx.add().iter().map(|p| p.download_size()).sum();

    if let Some(err) = prepare_err {
        let s = state.borrow();
        let response = PreflightResponse {
            error: Some(format!("Failed to prepare transaction: {}", err)),
            conflicts: s.conflicts.clone(),
            replacements: s.replacements.clone(),
            removals,
            providers: s.providers.clone(),
            import_keys: s.import_keys.clone(),
            ..Default::default()
        };
        return emit_json(&response);
    }

    if packages_to_upgrade == 0 && removals.is_empty() {
        let response = PreflightResponse {
            success: true,
            ..Default::default()
        };
        return emit_json(&response);
    }

    let upgrade_pkgs = tx.add();
    let upgrade_names: Vec<String> = upgrade_pkgs.iter().map(|p| p.name().to_string()).collect();

    let mut warnings = Vec::new();

    let firmware_pkgs: Vec<String> = upgrade_names
        .iter()
        .filter(|name| {
            name.starts_with("linux-firmware") || *name == "amd-ucode" || *name == "intel-ucode"
        })
        .cloned()
        .collect();

    let has_kernel = upgrade_pkgs
        .iter()
        .any(|p| is_kernel_package(p.name(), p.provides().iter().map(|d| d.name().to_string())));

    if !firmware_pkgs.is_empty() && !has_kernel {
        warnings.push(PreflightWarning {
            id: "firmware_without_kernel".to_string(),
            severity: WarningSeverity::Warning,
            title: "Firmware upgrade without kernel".to_string(),
            message: "Firmware packages are being upgraded without a matching kernel upgrade. \
                This can cause boot failures if the new firmware is incompatible with the \
                installed kernel. Consider upgrading the kernel at the same time, or verify \
                compatibility before rebooting."
                .to_string(),
            packages: firmware_pkgs,
            blocking: false,
            disk: None,
        });
    }

    // is pulled in, so the confirm can show what goes beyond the selection.
    let targets: Vec<String> = upgrade_names
        .iter()
        .filter(|name| tx.localdb().pkg(name.as_str()).is_ok())
        .cloned()
        .collect();
    let (add, remove) = preview_items(&tx, &targets, false);
    let (_, net_installed_size) = preview_totals(&add, &remove);
    warnings.extend(crate::space::check(total_download_size, net_installed_size));

    let s = state.borrow();
    let response = PreflightResponse {
        success: true,
        error: None,
        conflicts: s.conflicts.clone(),
        replacements: s.replacements.clone(),
        removals,
        providers: s.providers.clone(),
        import_keys: s.import_keys.clone(),
        warnings,
        packages_to_upgrade,
        total_download_size,
        add,
        remove,
        net_installed_size,
    };
    emit_json(&response)
}

pub fn sync_database(force: bool, timeout_secs: Option<u64>) -> Result<()> {
    crate::network::require_network()?;
    setup_signal_handler()?;
    spawn_cancel_listener()?;
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    check_cancel_early!(&timeout);

    let mut handle = get_handle()?;
    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle, Verbosity::Streaming);

    match crate::alpm::sync_databases(&mut handle, force) {
        Ok(_) => {
            invalidate_repo_map_cache();
            let check_result = check_cancel(&timeout);
            if !matches!(check_result, CheckResult::Continue) {
                emit_cancellation_complete(&check_result);
            } else {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    code: None,
                    details: None,
                    message: None,
                });
            }
            Ok(())
        }
        Err(e) => {
            let check_result = check_cancel(&timeout);
            if !matches!(check_result, CheckResult::Continue) {
                emit_cancellation_complete(&check_result);
                Ok(())
            } else {
                emit_failure(&e.to_string(), "transaction_failed");
                Err(e)
            }
        }
    }
}

pub fn run_upgrade(
    ignore_pkgs: &[String],
    timeout_secs: Option<u64>,
    approved_removals: &[String],
) -> Result<()> {
    crate::network::require_network()?;
    for name in approved_removals {
        crate::validation::validate_package_name(name)?;
    }
    let (mut handle, timeout) = begin_mutation(
        EventScope::Upgrade,
        MutationOpts {
            questions: Some(true),
        },
        timeout_secs,
    )?;

    for pkg_name in effective_ignored_packages(ignore_pkgs)? {
        handle.add_ignorepkg(pkg_name.as_str()).inspect_err(|e| {
            emit_failure(
                &format!("Failed to ignore package {}: {}", pkg_name, e),
                "transaction_failed",
            );
        })?;
    }

    if let Err(e) = crate::alpm::sync_databases(&mut handle, false) {
        emit_failure(
            &format!("Failed to refresh package databases: {}", e),
            "transaction_failed",
        );
        return Err(e);
    }
    invalidate_repo_map_cache();

    check_cancel_early!(&timeout);

    let _inhibitor = ShutdownInhibitor::take("Applying package changes");

    match run_sysupgrade(&mut handle, &timeout, None, Some(approved_removals))? {
        SysupgradeOutcome::CancelledEarly(r) => {
            emit_cancellation_complete(&r);
            Ok(())
        }
        SysupgradeOutcome::SyncFailed(e) => {
            emit_failure(
                &format!("Failed to prepare system upgrade: {}", e),
                "transaction_failed",
            );
            Err(anyhow::anyhow!(e))
        }
        SysupgradeOutcome::PrepareFailed(e) => Err(prepare_failure(&e)),
        SysupgradeOutcome::NothingToDo => {
            emit_event(&StreamEvent::Complete {
                success: true,
                code: None,
                details: None,
                message: Some("System is up to date".to_string()),
            });
            Ok(())
        }
        SysupgradeOutcome::Upgraded { .. } => {
            emit_event(&StreamEvent::Complete {
                success: true,
                code: None,
                details: None,
                message: None,
            });
            Ok(())
        }
        SysupgradeOutcome::CompletedDespiteCancel { .. } => {
            emit_event(&StreamEvent::Complete {
                success: true,
                code: None,
                details: None,
                message: None,
            });
            Ok(())
        }
        // Intervention needs flags; with None it cannot occur, but map it to
        // the failure wire message rather than panic.
        SysupgradeOutcome::CommitFailed(e)
        | SysupgradeOutcome::Intervention { error: Some(e), .. } => Err(fail_complete(format!(
            "Failed to commit transaction: {}",
            e
        ))),
        SysupgradeOutcome::Intervention { error: None, .. } => {
            Err(prepare_failure("manual intervention required"))
        }
    }
}

pub fn remove_orphans(timeout_secs: Option<u64>) -> Result<()> {
    let (mut handle, timeout) = begin_mutation(
        EventScope::Remove,
        MutationOpts { questions: None },
        timeout_secs,
    )?;

    let orphan_names: Vec<String> = {
        let localdb = handle.localdb();
        localdb
            .pkgs()
            .iter()
            .filter(|pkg| {
                pkg.reason() == alpm::PackageReason::Depend
                    && pkg.required_by().is_empty()
                    && pkg.optional_for().is_empty()
            })
            .map(|pkg| pkg.name().to_string())
            .collect()
    };

    if orphan_names.is_empty() {
        emit_event(&StreamEvent::Complete {
            success: true,
            code: None,
            details: None,
            message: Some("No orphan packages to remove".to_string()),
        });
        return Ok(());
    }

    check_cancel_early!(&timeout);

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::RECURSE)?;

    for name in &orphan_names {
        if let Ok(pkg) = tx.localdb().pkg(name.as_str())
            && let Err(e) = tx.remove_pkg(pkg)
        {
            emit_event(&StreamEvent::Log {
                level: "warning".to_string(),
                message: format!("Failed to mark {} for removal: {}", name, e),
            });
        }
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err() {
        return Err(prepare_failure(&err_msg));
    }

    if tx.remove().is_empty() {
        emit_event(&StreamEvent::Complete {
            success: true,
            code: None,
            details: None,
            message: Some("No packages to remove".to_string()),
        });
        return Ok(());
    }

    commit_and_complete(
        &mut tx,
        &timeout,
        Some(format!("Removed {} orphan package(s)", orphan_names.len())),
    )
}

pub fn install_package(
    name: &str,
    timeout_secs: Option<u64>,
    approved_removals: &[String],
) -> Result<()> {
    crate::network::require_network()?;
    let (mut handle, timeout) = begin_mutation(
        EventScope::Install,
        MutationOpts {
            questions: Some(!approved_removals.is_empty()),
        },
        timeout_secs,
    )?;

    check_cancel_early!(&timeout);

    let not_found = || fail_complete(format!("Package '{}' not found in any repository", name));

    // Resolved before taking the transaction (and the db lock), so a missing
    // package is reported as such even when another operation holds the lock.
    if !handle.syncdbs().iter().any(|db| db.pkg(name).is_ok()) {
        return Err(not_found());
    }

    let mut tx = match TransactionGuard::new(&mut handle, TransFlag::NONE) {
        Ok(tx) => tx,
        Err(e) => {
            emit_failure(&e.to_string(), "transaction_failed");
            return Err(e);
        }
    };

    let Some(pkg) = tx.syncdbs().iter().find_map(|db| db.pkg(name).ok()) else {
        return Err(not_found());
    };
    if let Err(e) = tx.add_pkg(pkg) {
        return Err(add_pkg_failure(name, e));
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err() {
        return Err(prepare_failure(&err_msg));
    }

    crate::alpm::check_approved_removals(
        tx.remove().iter().map(|pkg| pkg.name()),
        approved_removals,
    )
    .map_err(|e| prepare_failure(&e))?;

    commit_and_complete(
        &mut tx,
        &timeout,
        Some(format!("Successfully installed {}", name)),
    )
}

pub fn remove_package(
    name: &str,
    timeout_secs: Option<u64>,
    approved_removals: &[String],
) -> Result<()> {
    let (mut handle, timeout) = begin_mutation(
        EventScope::Remove,
        MutationOpts { questions: None },
        timeout_secs,
    )?;

    check_cancel_early!(&timeout);

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::RECURSE)?;

    let mark_result = tx
        .localdb()
        .pkg(name)
        .map_err(|e| format!("{}", e))
        .and_then(|pkg| tx.remove_pkg(pkg).map_err(|e| format!("{}", e)));

    if let Err(err_msg) = mark_result {
        return Err(fail_complete(format!(
            "Failed to mark '{}' for removal: {}",
            name, err_msg
        )));
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err() {
        return Err(prepare_failure(&err_msg));
    }

    let allowed: Vec<String> = std::iter::once(name)
        .chain(approved_removals.iter().map(String::as_str))
        .map(str::to_string)
        .collect();
    crate::alpm::check_approved_removals(tx.remove().iter().map(|pkg| pkg.name()), &allowed)
        .map_err(fail_complete)?;

    commit_and_complete(
        &mut tx,
        &timeout,
        Some(format!("Successfully removed {}", name)),
    )
}

fn emit_preview_error(message: String) -> Result<()> {
    emit_json(&TransactionPreview {
        error: Some(message),
        ..Default::default()
    })
}

/// What a prepared transaction adds and removes, with each package's reason.
/// `removing` marks a removal transaction: its non-target removals are
/// dependencies; in an install or upgrade, removals come from conflicts.
fn preview_items(
    tx: &TransactionGuard,
    targets: &[String],
    removing: bool,
) -> (Vec<PreviewAdd>, Vec<PreviewRemove>) {
    let add = tx
        .add()
        .iter()
        .map(|p| {
            let old = tx.localdb().pkg(p.name()).ok();
            PreviewAdd {
                name: p.name().to_string(),
                version: p.version().to_string(),
                repo: p.db().map(|db| db.name().to_string()),
                download_size: p.download_size(),
                installed_size: p.isize(),
                old_version: old.map(|o| o.version().to_string()),
                old_installed_size: old.map(|o| o.isize()),
                reason: AddReason::Dependency,
            }
        })
        .collect();
    let remove = tx
        .remove()
        .iter()
        .map(|p| PreviewRemove {
            name: p.name().to_string(),
            version: p.version().to_string(),
            installed_size: p.isize(),
            reason: RemoveReason::Dependency,
        })
        .collect();
    assign_reasons(add, remove, targets, removing)
}

fn assign_reasons(
    mut add: Vec<PreviewAdd>,
    mut remove: Vec<PreviewRemove>,
    targets: &[String],
    removing: bool,
) -> (Vec<PreviewAdd>, Vec<PreviewRemove>) {
    let is_target = |name: &str| targets.iter().any(|t| t == name);
    for p in &mut add {
        p.reason = if is_target(&p.name) {
            AddReason::Target
        } else {
            AddReason::Dependency
        };
    }
    for p in &mut remove {
        p.reason = match (removing, is_target(&p.name)) {
            (false, _) => RemoveReason::Conflict,
            (true, true) => RemoveReason::Target,
            (true, false) => RemoveReason::Dependency,
        };
    }
    (add, remove)
}

fn finish_preview(
    tx: &mut TransactionGuard,
    targets: &[String],
    removing: bool,
    state: &Rc<RefCell<PreflightState>>,
    warnings: Vec<PreflightWarning>,
) -> Result<()> {
    emit_json(&build_preview(tx, targets, removing, state, warnings)?)
}

/// Prepares the transaction, never commits it, and returns what it would do.
pub(crate) fn build_preview(
    tx: &mut TransactionGuard,
    targets: &[String],
    removing: bool,
    state: &Rc<RefCell<PreflightState>>,
    mut warnings: Vec<PreflightWarning>,
) -> Result<TransactionPreview> {
    if is_cancelled() {
        anyhow::bail!("Operation cancelled");
    }

    // Questions fire inside prepare, so the state is read only afterwards.
    let prepared = tx.prepare_detailed();
    let s = state.borrow();

    if !s.declined_removals.is_empty() {
        warnings.push(PreflightWarning {
            id: "removal_declined".to_string(),
            severity: WarningSeverity::Danger,
            title: "Package dependencies could not be resolved".to_string(),
            message: "These install targets have dependencies that cannot be satisfied. \
                The install will fail because it does not skip unresolved targets."
                .to_string(),
            packages: s.declined_removals.clone(),
            blocking: false,
            disk: None,
        });
    }

    let mut preview = TransactionPreview {
        conflicts: s.conflicts.clone(),
        replacements: s.replacements.clone(),
        providers: s.providers.clone(),
        import_keys: s.import_keys.clone(),
        warnings,
        ..Default::default()
    };

    match prepared {
        Err(failure) => {
            preview.error = Some(format!("Failed to prepare transaction: {}", failure));
            preview.conflicts.extend(failure.conflicting);
            preview.blocked_by = failure.unsatisfied;
        }
        Ok(()) => {
            (preview.add, preview.remove) = preview_items(tx, targets, removing);
            let (download, net) = preview_totals(&preview.add, &preview.remove);
            preview.total_download_size = download;
            preview.net_installed_size = net;
            preview.success = true;
            preview.warnings.extend(crate::space::check(download, net));
        }
    }
    Ok(preview)
}

/// Previews an install without committing; a held lock returns database_locked.
pub fn preflight_install(name: &str) -> Result<()> {
    setup_signal_handler()?;

    let mut handle = get_handle()?;
    let state = Rc::new(RefCell::new(PreflightState::default()));
    record_questions(&mut handle, &state);

    let not_found = || format!("Package '{}' not found in any repository", name);
    if !handle.syncdbs().iter().any(|db| db.pkg(name).is_ok()) {
        return emit_preview_error(not_found());
    }

    if is_cancelled() {
        anyhow::bail!("Operation cancelled");
    }

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::NONE)?;

    let Some(pkg) = tx.syncdbs().iter().find_map(|db| db.pkg(name).ok()) else {
        return emit_preview_error(not_found());
    };
    if let Err(e) = tx.add_pkg(pkg) {
        return emit_preview_error(format!("Failed to add '{}' to transaction: {}", name, e));
    }

    finish_preview(&mut tx, &[name.to_string()], false, &state, Vec::new())
}

/// Previews `remove-package NAME` with the same RECURSE flag. Packages that
/// still need NAME come back in `blocked_by` with success false.
pub fn preflight_remove(name: &str) -> Result<()> {
    setup_signal_handler()?;

    let mut handle = get_handle()?;
    // remove-package sets no question callback, so neither does its preview.
    let state = Rc::new(RefCell::new(PreflightState::default()));

    if handle.localdb().pkg(name).is_err() {
        return emit_preview_error(format!("Package '{}' is not installed", name));
    }

    if is_cancelled() {
        anyhow::bail!("Operation cancelled");
    }

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::RECURSE)?;

    let mark_result = tx
        .localdb()
        .pkg(name)
        .map_err(|e| e.to_string())
        .and_then(|pkg| tx.remove_pkg(pkg).map_err(|e| e.to_string()));
    if let Err(err_msg) = mark_result {
        return emit_preview_error(format!(
            "Failed to mark '{}' for removal: {}",
            name, err_msg
        ));
    }

    finish_preview(&mut tx, &[name.to_string()], true, &state, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn add(name: &str, old: Option<(&str, i64)>) -> PreviewAdd {
        PreviewAdd {
            name: name.to_string(),
            version: "2-1".to_string(),
            repo: Some("core".to_string()),
            download_size: 10,
            installed_size: 100,
            old_version: old.map(|(v, _)| v.to_string()),
            old_installed_size: old.map(|(_, s)| s),
            reason: AddReason::Dependency,
        }
    }

    fn remove(name: &str) -> PreviewRemove {
        PreviewRemove {
            name: name.to_string(),
            version: "1-1".to_string(),
            installed_size: 50,
            reason: RemoveReason::Dependency,
        }
    }

    fn reasons(
        add: &[PreviewAdd],
        remove: &[PreviewRemove],
    ) -> (Vec<AddReason>, Vec<RemoveReason>) {
        (
            add.iter().map(|p| p.reason).collect(),
            remove.iter().map(|p| p.reason).collect(),
        )
    }

    #[test]
    fn assign_reasons_install_marks_conflict_removals() {
        let (a, r) = assign_reasons(
            vec![add("foo", None), add("libdep", None)],
            vec![remove("foo-legacy")],
            &names(&["foo"]),
            false,
        );
        assert_eq!(
            reasons(&a, &r),
            (
                vec![AddReason::Target, AddReason::Dependency],
                vec![RemoveReason::Conflict]
            )
        );
    }

    #[test]
    fn assign_reasons_removal_splits_targets_from_dependencies() {
        let (a, r) = assign_reasons(
            vec![],
            vec![remove("foo"), remove("libdep")],
            &names(&["foo"]),
            true,
        );
        assert!(a.is_empty());
        assert_eq!(
            reasons(&a, &r).1,
            vec![RemoveReason::Target, RemoveReason::Dependency]
        );
    }

    #[test]
    fn assign_reasons_keeps_every_other_field() {
        let before = add("glibc", Some(("1-1", 80)));
        let (a, _) = assign_reasons(vec![before.clone()], vec![], &names(&["glibc"]), false);
        assert_eq!(
            a,
            vec![PreviewAdd {
                reason: AddReason::Target,
                ..before
            }]
        );
    }

    #[test]
    fn upgrade_targets_are_upgrades_and_new_packages_are_dependencies() {
        let adds = vec![add("glibc", Some(("1-1", 80))), add("libnew", None)];
        let targets: Vec<String> = adds
            .iter()
            .filter(|p| p.old_version.is_some())
            .map(|p| p.name.clone())
            .collect();
        let (a, r) = assign_reasons(adds, vec![remove("old")], &targets, false);
        assert_eq!(
            reasons(&a, &r),
            (
                vec![AddReason::Target, AddReason::Dependency],
                vec![RemoveReason::Conflict]
            )
        );
        assert_eq!(preview_totals(&a, &r), (20, 20 + 100 - 50));
    }

    #[test]
    fn preflight_with_preview_serialises_to_fixture() {
        let target =
            |name: &str, version: &str, old: &str, dl: i64, size: i64, old_size: i64| PreviewAdd {
                name: name.to_string(),
                version: version.to_string(),
                repo: Some("core".to_string()),
                download_size: dl,
                installed_size: size,
                old_version: Some(old.to_string()),
                old_installed_size: Some(old_size),
                reason: AddReason::Target,
            };
        let add = vec![
            target(
                "linux",
                "6.7.1-arch1-1",
                "6.7.0-arch1-1",
                150_000_000,
                145_000_000,
                142_000_000,
            ),
            target(
                "glibc", "2.39-1", "2.38-1", 8_200_000, 45_000_000, 44_000_000,
            ),
            PreviewAdd {
                name: "libxcrypt".to_string(),
                version: "4.4.36-1".to_string(),
                repo: Some("core".to_string()),
                download_size: 120_000,
                installed_size: 400_000,
                old_version: None,
                old_installed_size: None,
                reason: AddReason::Dependency,
            },
        ];
        let remove = vec![PreviewRemove {
            name: "libxcrypt-legacy".to_string(),
            version: "4.4.33-1".to_string(),
            installed_size: 300_000,
            reason: RemoveReason::Conflict,
        }];
        let (download, net) = preview_totals(&add, &remove);
        let response = PreflightResponse {
            success: true,
            conflicts: vec![ConflictInfo {
                package1: "libxcrypt".to_string(),
                package2: "libxcrypt-legacy".to_string(),
            }],
            packages_to_upgrade: add.len(),
            total_download_size: download,
            add,
            remove,
            net_installed_size: net,
            ..Default::default()
        };
        let fixture: Option<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../test/fixtures/preflight-upgrade-preview.json"
        ))
        .ok();
        assert!(fixture.is_some());
        assert_eq!(serde_json::to_value(&response).ok(), fixture);
    }

    #[test]
    fn preflight_fixtures_without_preview_still_deserialise() {
        for fixture in [
            include_str!("../../../test/fixtures/preflight.json"),
            include_str!("../../../test/fixtures/preflight-with-data.json"),
        ] {
            let response = serde_json::from_str::<PreflightResponse>(fixture)
                .ok()
                .map(|r| (r.success, r.add.len(), r.remove.len(), r.net_installed_size));
            assert_eq!(response, Some((true, 0, 0, 0)));
        }
    }

    #[test]
    fn kernel_by_name_linux() {
        assert!(is_kernel_package("linux", std::iter::empty::<&str>()));
    }

    #[test]
    fn kernel_by_name_linux_lts() {
        assert!(is_kernel_package("linux-lts", std::iter::empty::<&str>()));
    }

    #[test]
    fn kernel_by_name_linux_zen() {
        assert!(is_kernel_package("linux-zen", std::iter::empty::<&str>()));
    }

    #[test]
    fn kernel_by_name_linux_hardened() {
        assert!(is_kernel_package(
            "linux-hardened",
            std::iter::empty::<&str>()
        ));
    }

    #[test]
    fn kernel_by_name_linux_rt() {
        assert!(is_kernel_package("linux-rt", std::iter::empty::<&str>()));
    }

    #[test]
    fn kernel_by_name_linux_rt_lts() {
        assert!(is_kernel_package(
            "linux-rt-lts",
            std::iter::empty::<&str>()
        ));
    }

    #[test]
    fn kernel_via_provides_linux() {
        assert!(is_kernel_package(
            "linux-custom",
            ["linux", "linux-headers"].iter().copied()
        ));
    }

    #[test]
    fn non_kernel_package() {
        assert!(!is_kernel_package(
            "linux-firmware",
            ["firmware"].iter().copied()
        ));
    }

    #[test]
    fn hook_position_known_total() {
        assert_eq!(hook_position(3, 12), Some((3, 12)));
    }

    #[test]
    fn hook_position_zero_total_is_none() {
        assert_eq!(hook_position(0, 0), None);
    }

    #[test]
    fn event_serializes_position_when_set() {
        let json = serde_json::to_string(&StreamEvent::Event {
            event: "hook_run_start".to_string(),
            package: Some("systemd-update".to_string()),
            current: Some(2),
            total: Some(5),
        })
        .ok();
        assert_eq!(
            json.as_deref(),
            Some(
                r#"{"type":"event","event":"hook_run_start","package":"systemd-update","current":2,"total":5}"#
            )
        );
    }

    #[test]
    fn event_omits_position_when_unset() {
        let json = serde_json::to_string(&StreamEvent::Event {
            event: "transaction_start".to_string(),
            package: None,
            current: None,
            total: None,
        })
        .ok();
        assert_eq!(
            json.as_deref(),
            Some(r#"{"type":"event","event":"transaction_start","package":null}"#)
        );
    }
}
