use alpm::{Alpm, AnyEvent, AnyQuestion, Event, PackageOperation, Progress, Question, TransFlag};
use anyhow::Result;
use std::cell::RefCell;
use std::rc::Rc;

use crate::alpm::{
    TransactionGuard, get_handle, interrupt_if_cancelled, progress_to_string, setup_dl_cb,
    setup_log_cb, try_interrupt,
};
use crate::check_cancel_early;
use crate::db::invalidate_repo_map_cache;
use crate::models::{
    ConflictInfo, KeyInfo, PreflightResponse, PreflightState, PreflightWarning, ProviderChoice,
    ReplacementInfo, StreamEvent, WarningSeverity,
};
use crate::util::{
    CheckResult, DEFAULT_MUTATION_TIMEOUT_SECS, TimeoutGuard, check_cancel,
    emit_cancellation_complete, emit_event, emit_json, handle_commit_error, is_cancelled,
    setup_signal_handler, spawn_cancel_listener,
};

const KERNEL_PACKAGES: &[&str] = &[
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
enum EventScope {
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

fn setup_progress_cb(handle: &mut Alpm) {
    handle.set_progress_cb(
        (),
        |progress: Progress,
         pkgname: &str,
         percent: i32,
         howmany: usize,
         current: usize,
         _: &mut ()| {
            if is_cancelled() {
                try_interrupt();
                return;
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
}

fn setup_event_cb(handle: &mut Alpm, scope: EventScope) {
    handle.set_event_cb((), move |event: AnyEvent, _: &mut ()| {
        interrupt_if_cancelled();
        let (event_str, pkg_name) = match event.event() {
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
                (op_name.to_string(), Some(pkg_name))
            }
            Event::ScriptletInfo(info) if scope.verbose() => {
                ("scriptlet".to_string(), Some(info.line().to_string()))
            }
            Event::DatabaseMissing(db) if scope.verbose() => {
                ("db_missing".to_string(), Some(db.dbname().to_string()))
            }
            Event::RetrieveStart if scope.verbose() => ("retrieve_start".to_string(), None),
            Event::RetrieveDone if scope.verbose() => ("retrieve_done".to_string(), None),
            Event::RetrieveFailed if scope.verbose() => ("retrieve_failed".to_string(), None),
            Event::TransactionStart => ("transaction_start".to_string(), None),
            Event::TransactionDone => ("transaction_done".to_string(), None),
            Event::HookStart(_) => ("hook_start".to_string(), None),
            Event::HookDone(_) => ("hook_done".to_string(), None),
            Event::HookRunStart(h) => ("hook_run_start".to_string(), Some(h.name().to_string())),
            Event::HookRunDone(h) => ("hook_run_done".to_string(), Some(h.name().to_string())),
            _ if scope == EventScope::Upgrade => ("other".to_string(), None),
            _ => return,
        };
        emit_event(&StreamEvent::Event {
            event: event_str,
            package: pkg_name,
        });
    });
}

/// Auto-answers alpm questions during a streaming mutation, logging each
/// decision. `answer_remove_pkgs` confirms dependent-removal prompts; when
/// false the prompt keeps alpm's default answer.
fn setup_question_cb(handle: &mut Alpm, answer_remove_pkgs: bool) {
    handle.set_question_cb(
        (),
        move |mut question: AnyQuestion, _: &mut ()| match question.question() {
            Question::Conflict(q) => {
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
                if answer_remove_pkgs {
                    let pkgs: Vec<String> =
                        q.packages().iter().map(|p| p.name().to_string()).collect();
                    emit_event(&StreamEvent::Log {
                        level: "info".to_string(),
                        message: format!("Removing packages as confirmed: {}", pkgs.join(", ")),
                    });
                    question.set_answer(true);
                }
            }
            Question::Replace(q) => {
                let old_pkg = q.oldpkg().name().to_string();
                let new_pkg = q.newpkg().name().to_string();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Replacing {} with {}", old_pkg, new_pkg),
                });
                question.set_answer(true);
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
                    level: "info".to_string(),
                    message: format!("Importing PGP key {} ({})", fingerprint, uid),
                });
                question.set_answer(true);
            }
        },
    );
}

fn prepare_failure(err_msg: &str) -> anyhow::Error {
    let message = format!("Failed to prepare transaction: {}", err_msg);
    emit_event(&StreamEvent::Complete {
        success: false,
        message: Some(message.clone()),
    });
    anyhow::anyhow!(message)
}

fn commit_and_complete(
    tx: &mut TransactionGuard,
    timeout: &TimeoutGuard,
    interrupt_msg: &str,
    success_msg: Option<String>,
) -> Result<()> {
    match tx.commit().err().map(|e| e.to_string()) {
        Some(err_msg) => {
            handle_commit_error(&err_msg, is_cancelled(), timeout, interrupt_msg).map(|_| ())
        }
        None => {
            // Invariant: enqueue the success signal immediately after commit()
            // returns Ok, before anything else. emit_event hands it to the async
            // stdout writer; main drains the writer (shutdown_event_writer) before
            // the process exits, so a succeeded upgrade always reports success and
            // is never lost. Do not insert work between commit() and here.
            emit_event(&StreamEvent::Complete {
                success: true,
                message: success_msg,
            });
            Ok(())
        }
    }
}

pub fn preflight_upgrade(ignore_pkgs: &[String]) -> Result<()> {
    // Before the lock: a timeout SIGTERM must set the flag, not kill the
    // process with db.lck held.
    setup_signal_handler();

    let mut handle = get_handle()?;

    for pkg_name in ignore_pkgs {
        handle.add_ignorepkg(pkg_name.as_str())?;
    }

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

    let prepare_success = tx.prepare().is_ok();

    let packages_to_upgrade = tx.add().len();
    let total_download_size: i64 = tx.add().iter().map(|p| p.download_size()).sum();

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
        return emit_json(&response);
    }

    if packages_to_upgrade == 0 {
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
        });
    }

    let s = state.borrow();
    let response = PreflightResponse {
        success: true,
        error: None,
        conflicts: s.conflicts.clone(),
        replacements: s.replacements.clone(),
        removals: s.removals.clone(),
        providers: s.providers.clone(),
        import_keys: s.import_keys.clone(),
        warnings,
        packages_to_upgrade,
        total_download_size,
    };
    emit_json(&response)
}

pub fn sync_database(force: bool, timeout_secs: Option<u64>) -> Result<()> {
    setup_signal_handler();
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    check_cancel_early!(&timeout);

    let mut handle = get_handle()?;
    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle);

    match handle.syncdbs_mut().update(force) {
        Ok(_) => {
            invalidate_repo_map_cache();
            let check_result = check_cancel(&timeout);
            if !matches!(check_result, CheckResult::Continue) {
                emit_cancellation_complete(&check_result);
            } else {
                emit_event(&StreamEvent::Complete {
                    success: true,
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
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(e.to_string()),
                });
                Err(e.into())
            }
        }
    }
}

pub fn run_upgrade(ignore_pkgs: &[String], timeout_secs: Option<u64>) -> Result<()> {
    setup_signal_handler();
    spawn_cancel_listener();
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    let mut handle = get_handle()?;

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
    setup_progress_cb(&mut handle);
    setup_event_cb(&mut handle, EventScope::Upgrade);
    setup_question_cb(&mut handle, true);

    check_cancel_early!(&timeout);

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::NONE)?;

    check_cancel_early!(&timeout);

    if let Err(e) = tx.sync_sysupgrade(false) {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!("Failed to prepare system upgrade: {}", e)),
        });
        return Err(e.into());
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err().map(|e| e.to_string()) {
        return Err(prepare_failure(&err_msg));
    }

    if tx.add().is_empty() && tx.remove().is_empty() {
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some("System is up to date".to_string()),
        });
        return Ok(());
    }

    check_cancel_early!(&timeout);

    commit_and_complete(
        &mut tx,
        &timeout,
        "Operation interrupted - system may be in inconsistent state",
        None,
    )
}

pub fn remove_orphans(timeout_secs: Option<u64>) -> Result<()> {
    setup_signal_handler();
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    let mut handle = get_handle()?;

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
            message: Some("No orphan packages to remove".to_string()),
        });
        return Ok(());
    }

    setup_log_cb(&mut handle);
    setup_progress_cb(&mut handle);
    setup_event_cb(&mut handle, EventScope::Remove);

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

    if let Some(err_msg) = tx.prepare().err().map(|e| e.to_string()) {
        return Err(prepare_failure(&err_msg));
    }

    if tx.remove().is_empty() {
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some("No packages to remove".to_string()),
        });
        return Ok(());
    }

    commit_and_complete(
        &mut tx,
        &timeout,
        "Operation interrupted",
        Some(format!("Removed {} orphan package(s)", orphan_names.len())),
    )
}

pub fn install_package(name: &str, timeout_secs: Option<u64>) -> Result<()> {
    setup_signal_handler();
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    let mut handle = get_handle()?;

    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle);
    setup_progress_cb(&mut handle);
    setup_event_cb(&mut handle, EventScope::Install);
    setup_question_cb(&mut handle, false);

    check_cancel_early!(&timeout);

    let not_found = || {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!("Package '{}' not found in any repository", name)),
        });
        anyhow::anyhow!("Package '{}' not found in any repository", name)
    };

    // Resolved before taking the transaction (and the db lock), so a missing
    // package is reported as such even when another operation holds the lock.
    if !handle.syncdbs().iter().any(|db| db.pkg(name).is_ok()) {
        return Err(not_found());
    }

    let mut tx = match TransactionGuard::new(&mut handle, TransFlag::NONE) {
        Ok(tx) => tx,
        Err(e) => {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(e.to_string()),
            });
            return Err(e);
        }
    };

    let Some(pkg) = tx.syncdbs().iter().find_map(|db| db.pkg(name).ok()) else {
        return Err(not_found());
    };
    if let Err(e) = tx.add_pkg(pkg) {
        let err_msg = format!("Failed to add '{}' to transaction: {}", name, e);
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(err_msg.clone()),
        });
        return Err(anyhow::anyhow!(err_msg));
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err().map(|e| e.to_string()) {
        return Err(prepare_failure(&err_msg));
    }

    commit_and_complete(
        &mut tx,
        &timeout,
        "Operation interrupted - package may be in inconsistent state",
        Some(format!("Successfully installed {}", name)),
    )
}

pub fn remove_package(name: &str, timeout_secs: Option<u64>) -> Result<()> {
    setup_signal_handler();
    let timeout = TimeoutGuard::new(timeout_secs.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS));

    let mut handle = get_handle()?;

    setup_log_cb(&mut handle);
    setup_progress_cb(&mut handle);
    setup_event_cb(&mut handle, EventScope::Remove);

    check_cancel_early!(&timeout);

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::RECURSE)?;

    let mark_result = tx
        .localdb()
        .pkg(name)
        .map_err(|e| format!("{}", e))
        .and_then(|pkg| tx.remove_pkg(pkg).map_err(|e| format!("{}", e)));

    if let Err(err_msg) = mark_result {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!(
                "Failed to mark '{}' for removal: {}",
                name, err_msg
            )),
        });
        return Err(anyhow::anyhow!(
            "Failed to mark '{}' for removal: {}",
            name,
            err_msg
        ));
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err().map(|e| e.to_string()) {
        return Err(prepare_failure(&err_msg));
    }

    commit_and_complete(
        &mut tx,
        &timeout,
        "Operation interrupted - package may be in inconsistent state",
        Some(format!("Successfully removed {}", name)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
