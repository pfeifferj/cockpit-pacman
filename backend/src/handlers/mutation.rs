use alpm::{AnyEvent, AnyQuestion, Event, PackageOperation, Progress, Question, TransFlag};
use anyhow::Result;
use std::cell::RefCell;
use std::rc::Rc;

use crate::alpm::{TransactionGuard, get_handle, progress_to_string, setup_dl_cb, setup_log_cb};
use crate::check_cancel_early;
use crate::db::invalidate_repo_map_cache;
use crate::models::{
    ConflictInfo, KeyInfo, PreflightResponse, PreflightState, ProviderChoice, ReplacementInfo,
    StreamEvent,
};
use crate::util::{
    CheckResult, DEFAULT_MUTATION_TIMEOUT_SECS, TimeoutGuard, check_cancel,
    emit_cancellation_complete, emit_event, is_cancelled, setup_signal_handler,
};

pub fn preflight_upgrade(ignore_pkgs: &[String]) -> Result<()> {
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

    if let Err(e) = tx.sync_sysupgrade(false) {
        let response = PreflightResponse {
            error: Some(format!("Failed to prepare system upgrade: {}", e)),
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
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
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    if packages_to_upgrade == 0 {
        let response = PreflightResponse {
            success: true,
            ..Default::default()
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
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
        packages_to_upgrade,
        total_download_size,
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
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

    handle.set_progress_cb(
        (),
        |progress: Progress,
         pkgname: &str,
         percent: i32,
         howmany: usize,
         current: usize,
         _: &mut ()| {
            if is_cancelled() {
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

    handle.set_question_cb((), |mut question: AnyQuestion, _: &mut ()| {
        match question.question() {
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
                let pkgs: Vec<String> = q.packages().iter().map(|p| p.name().to_string()).collect();
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Removing packages as confirmed: {}", pkgs.join(", ")),
                });
                question.set_answer(true);
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
        }
    });

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

    if tx.add().is_empty() && tx.remove().is_empty() {
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some("System is up to date".to_string()),
        });
        return Ok(());
    }

    let was_cancelled_before = is_cancelled();
    let was_timed_out_before = timeout.is_timed_out();
    let commit_err: Option<String> = tx.commit().err().map(|e| e.to_string());
    if let Some(err_msg) = commit_err {
        let cancelled_during = !was_cancelled_before && is_cancelled();
        let timed_out_during = !was_timed_out_before && timeout.is_timed_out();
        let err_lower = err_msg.to_lowercase();
        let error_indicates_interrupt = err_lower.contains("interrupt")
            || err_lower.contains("cancel")
            || err_lower.contains("signal")
            || err_lower.contains("timeout");

        if cancelled_during || error_indicates_interrupt {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(
                    "Operation interrupted - system may be in inconsistent state".to_string(),
                ),
            });
        } else if timed_out_during {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!(
                    "Operation timed out after {} seconds - system may be in inconsistent state",
                    timeout.timeout_secs()
                )),
            });
        } else {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!("Failed to commit transaction: {}", err_msg)),
            });
        }
        return Err(anyhow::anyhow!("Failed to commit transaction: {}", err_msg));
    }

    emit_event(&StreamEvent::Complete {
        success: true,
        message: None,
    });

    Ok(())
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

    handle.set_progress_cb(
        (),
        |progress: Progress,
         pkgname: &str,
         percent: i32,
         howmany: usize,
         current: usize,
         _: &mut ()| {
            if is_cancelled() {
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

    handle.set_event_cb((), |event: AnyEvent, _: &mut ()| {
        let (event_str, pkg_name) = match event.event() {
            Event::PackageOperationStart(op) | Event::PackageOperationDone(op) => {
                let (op_name, pkg_name) = match op.operation() {
                    PackageOperation::Remove(pkg) => ("remove", pkg.name().to_string()),
                    _ => return,
                };
                (op_name.to_string(), Some(pkg_name))
            }
            Event::TransactionStart => ("transaction_start".to_string(), None),
            Event::TransactionDone => ("transaction_done".to_string(), None),
            Event::HookStart(_) => ("hook_start".to_string(), None),
            Event::HookDone(_) => ("hook_done".to_string(), None),
            Event::HookRunStart(h) => ("hook_run_start".to_string(), Some(h.name().to_string())),
            Event::HookRunDone(h) => ("hook_run_done".to_string(), Some(h.name().to_string())),
            _ => return,
        };
        emit_event(&StreamEvent::Event {
            event: event_str,
            package: pkg_name,
        });
    });

    check_cancel_early!(&timeout);

    handle
        .trans_init(TransFlag::RECURSE)
        .map_err(|e| anyhow::anyhow!("Failed to initialize transaction: {}", e))?;

    for name in &orphan_names {
        if let Ok(pkg) = handle.localdb().pkg(name.as_str())
            && let Err(e) = handle.trans_remove_pkg(pkg)
        {
            emit_event(&StreamEvent::Log {
                level: "warning".to_string(),
                message: format!("Failed to mark {} for removal: {}", name, e),
            });
        }
    }

    check_cancel_early!(&timeout);

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

    if handle.trans_remove().is_empty() {
        let _ = handle.trans_release();
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some("No packages to remove".to_string()),
        });
        return Ok(());
    }

    let was_cancelled_before = is_cancelled();
    let was_timed_out_before = timeout.is_timed_out();
    let commit_err: Option<String> = handle.trans_commit().err().map(|e| e.to_string());
    if let Some(err_msg) = commit_err {
        let cancelled_during = !was_cancelled_before && is_cancelled();
        let timed_out_during = !was_timed_out_before && timeout.is_timed_out();
        let err_lower = err_msg.to_lowercase();
        let error_indicates_interrupt = err_lower.contains("interrupt")
            || err_lower.contains("cancel")
            || err_lower.contains("signal")
            || err_lower.contains("timeout");

        if cancelled_during || error_indicates_interrupt {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some("Operation interrupted".to_string()),
            });
        } else if timed_out_during {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!(
                    "Operation timed out after {} seconds",
                    timeout.timeout_secs()
                )),
            });
        } else {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!("Failed to commit transaction: {}", err_msg)),
            });
        }
        let _ = handle.trans_release();
        return Err(anyhow::anyhow!("Failed to commit transaction: {}", err_msg));
    }

    let _ = handle.trans_release();
    emit_event(&StreamEvent::Complete {
        success: true,
        message: Some(format!("Removed {} orphan package(s)", orphan_names.len())),
    });

    Ok(())
}
