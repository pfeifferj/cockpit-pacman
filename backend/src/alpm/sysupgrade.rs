use alpm::{Alpm, AnyQuestion, Question, TransFlag};
use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::TransactionGuard;
use crate::util::{CheckResult, TimeoutGuard, check_cancel};

/// Records alpm questions that need a human decision. Never answers, so
/// alpm's default (refuse) holds for every recorded question.
#[derive(Clone, Default)]
pub struct InterventionFlags {
    conflicts: Arc<AtomicBool>,
    removals: Arc<AtomicBool>,
    import_keys: Arc<AtomicBool>,
}

impl InterventionFlags {
    pub fn install(&self, handle: &mut Alpm) {
        let flags = self.clone();
        handle.set_question_cb((), move |question: AnyQuestion, _: &mut ()| match question
            .question()
        {
            Question::Conflict(_) => flags.conflicts.store(true, Ordering::SeqCst),
            Question::RemovePkgs(_) => flags.removals.store(true, Ordering::SeqCst),
            Question::ImportKey(_) => flags.import_keys.store(true, Ordering::SeqCst),
            Question::Replace(_) => flags.removals.store(true, Ordering::SeqCst),
            _ => {}
        });
    }

    pub fn reasons(&self) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        if self.conflicts.load(Ordering::SeqCst) {
            reasons.push("conflicts detected");
        }
        if self.removals.load(Ordering::SeqCst) {
            reasons.push("package removals required");
        }
        if self.import_keys.load(Ordering::SeqCst) {
            reasons.push("key imports required");
        }
        reasons
    }
}

#[derive(Debug, PartialEq)]
pub enum SysupgradeOutcome {
    NothingToDo,
    Upgraded {
        packages: usize,
    },
    CancelledEarly(CheckResult),
    Interrupted,
    CompletedDespiteCancel {
        packages: usize,
    },
    /// A recorded question kept alpm's refusal; the run needs a human.
    Intervention {
        reasons: Vec<&'static str>,
        error: Option<String>,
    },
    SyncFailed(String),
    PrepareFailed(String),
    CommitFailed(String),
}

macro_rules! checkpoint {
    ($timeout:expr) => {
        match check_cancel($timeout) {
            CheckResult::Continue => {}
            r => return Ok(SysupgradeOutcome::CancelledEarly(r)),
        }
    };
}

/// One sysupgrade transaction: init, sync, prepare, gate, commit. Callbacks
/// and reporting stay with the caller. `flags` gates the run for unattended
/// callers (which must have called `install` on the handle); interactive
/// callers pass None and answer in their own question cb. Callers hold a
/// ShutdownInhibitor across this call and their result recording. Err only
/// when the transaction cannot be initialized.
pub fn run_sysupgrade(
    handle: &mut Alpm,
    timeout: &TimeoutGuard,
    flags: Option<&InterventionFlags>,
) -> Result<SysupgradeOutcome> {
    checkpoint!(timeout);

    let mut tx = TransactionGuard::new(handle, TransFlag::NONE)?;

    if let Err(e) = tx.sync_sysupgrade(false) {
        return Ok(SysupgradeOutcome::SyncFailed(e.to_string()));
    }

    checkpoint!(timeout);

    // Stringify immediately: PrepareError borrows the transaction.
    let prepare_err = tx.prepare().err().map(|e| e.to_string());

    // The gate reads after prepare() so prepare-time questions are seen, and
    // it outranks a prepare error: a conflict both sets its flag and fails
    // prepare (the recorded question kept alpm's refusal), and that needs a
    // human, not a failure record.
    if let Some(f) = flags {
        let reasons = f.reasons();
        if !reasons.is_empty() {
            return Ok(SysupgradeOutcome::Intervention {
                reasons,
                error: prepare_err,
            });
        }
    }
    if let Some(e) = prepare_err {
        return Ok(SysupgradeOutcome::PrepareFailed(e));
    }

    let packages = tx.add().len();
    if packages == 0 && tx.remove().is_empty() {
        return Ok(SysupgradeOutcome::NothingToDo);
    }
    let targets: Vec<String> = tx.add().iter().map(|p| p.name().to_string()).collect();

    checkpoint!(timeout);

    let commit_err = tx.commit().err().map(|e| e.to_string());
    let check = check_cancel(timeout);
    let intervention = flags.map(|f| f.reasons()).filter(|r| !r.is_empty());
    drop(tx);

    match commit_err {
        None => Ok(classify_commit_ok(check, packages, || {
            applied_state(handle, &targets)
        })),
        Some(e) => Ok(classify_commit_error(check, intervention, e)),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Applied {
    All,
    None,
    Some,
}

fn applied_state(handle: &Alpm, targets: &[String]) -> Applied {
    let local = handle.localdb();
    let landed = targets
        .iter()
        .filter(|name| match local.pkg(name.as_str()) {
            Ok(installed) => !handle.syncdbs().iter().any(|db| {
                db.pkg(name.as_str())
                    .map(|sync| sync.version() > installed.version())
                    .unwrap_or(false)
            }),
            Err(_) => false,
        })
        .count();

    applied_from_counts(landed, targets.len())
}

fn applied_from_counts(landed: usize, planned: usize) -> Applied {
    match landed {
        0 => Applied::None,
        n if n == planned => Applied::All,
        _ => Applied::Some,
    }
}

/// alpm returns Ok both from an interrupted commit and a completed one; the db settles which.
fn classify_commit_ok(
    check: CheckResult,
    packages: usize,
    applied: impl FnOnce() -> Applied,
) -> SysupgradeOutcome {
    match check {
        CheckResult::Cancelled => match applied() {
            Applied::All => SysupgradeOutcome::CompletedDespiteCancel { packages },
            Applied::None => SysupgradeOutcome::CancelledEarly(CheckResult::Cancelled),
            Applied::Some => SysupgradeOutcome::Interrupted,
        },
        CheckResult::Continue | CheckResult::TimedOut(_) => {
            SysupgradeOutcome::Upgraded { packages }
        }
    }
}

fn classify_commit_error(
    check: CheckResult,
    intervention: Option<Vec<&'static str>>,
    error: String,
) -> SysupgradeOutcome {
    match check {
        CheckResult::Cancelled => SysupgradeOutcome::Interrupted,
        CheckResult::Continue | CheckResult::TimedOut(_) => match intervention {
            Some(reasons) => SysupgradeOutcome::Intervention {
                reasons,
                error: Some(error),
            },
            None => SysupgradeOutcome::CommitFailed(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Applied, InterventionFlags, SysupgradeOutcome, applied_from_counts, classify_commit_error,
        classify_commit_ok,
    };
    use crate::util::CheckResult;
    use std::sync::atomic::Ordering;

    #[test]
    fn an_empty_plan_never_reads_as_fully_applied() {
        assert_eq!(applied_from_counts(0, 0), Applied::None);
    }

    #[test]
    fn a_partly_applied_plan_reads_as_some() {
        assert_eq!(applied_from_counts(0, 3), Applied::None);
        assert_eq!(applied_from_counts(2, 3), Applied::Some);
        assert_eq!(applied_from_counts(3, 3), Applied::All);
    }

    #[test]
    fn reasons_are_stable_and_ordered() {
        let flags = InterventionFlags::default();
        assert!(flags.reasons().is_empty());

        flags.import_keys.store(true, Ordering::SeqCst);
        flags.conflicts.store(true, Ordering::SeqCst);
        flags.removals.store(true, Ordering::SeqCst);
        assert_eq!(
            flags.reasons(),
            vec![
                "conflicts detected",
                "package removals required",
                "key imports required"
            ]
        );
    }

    #[test]
    fn an_ok_commit_with_a_pending_cancel_is_classified_by_what_landed() {
        assert_eq!(
            classify_commit_ok(CheckResult::Cancelled, 10, || Applied::All),
            SysupgradeOutcome::CompletedDespiteCancel { packages: 10 }
        );
        assert_eq!(
            classify_commit_ok(CheckResult::Cancelled, 10, || Applied::None),
            SysupgradeOutcome::CancelledEarly(CheckResult::Cancelled)
        );
        assert_eq!(
            classify_commit_ok(CheckResult::Cancelled, 10, || Applied::Some),
            SysupgradeOutcome::Interrupted
        );
    }

    #[test]
    fn an_ok_commit_without_a_cancel_is_an_upgrade() {
        assert_eq!(
            classify_commit_ok(CheckResult::Continue, 10, || panic!("must not re-check")),
            SysupgradeOutcome::Upgraded { packages: 10 }
        );
        assert_eq!(
            classify_commit_ok(CheckResult::TimedOut(1800), 10, || panic!(
                "must not re-check"
            )),
            SysupgradeOutcome::Upgraded { packages: 10 }
        );
    }

    #[test]
    fn commit_error_classification_precedence() {
        let reasons = || Some(vec!["key imports required"]);

        assert_eq!(
            classify_commit_error(CheckResult::Cancelled, reasons(), "err".into()),
            SysupgradeOutcome::Interrupted
        );
        assert_eq!(
            classify_commit_error(CheckResult::TimedOut(300), None, "err".into()),
            SysupgradeOutcome::CommitFailed("err".into())
        );
        assert_eq!(
            classify_commit_error(CheckResult::TimedOut(300), reasons(), "err".into()),
            SysupgradeOutcome::Intervention {
                reasons: vec!["key imports required"],
                error: Some("err".into())
            }
        );
        assert_eq!(
            classify_commit_error(CheckResult::Continue, reasons(), "err".into()),
            SysupgradeOutcome::Intervention {
                reasons: vec!["key imports required"],
                error: Some("err".into())
            }
        );
        assert_eq!(
            classify_commit_error(CheckResult::Continue, None, "err".into()),
            SysupgradeOutcome::CommitFailed("err".into())
        );
    }
}
