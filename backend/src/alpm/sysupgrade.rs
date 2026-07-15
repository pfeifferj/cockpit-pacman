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
    /// Cancel/timeout observed at a checkpoint, before any commit started.
    CancelledEarly(CheckResult),
    /// Commit errored while a cancel/timeout was pending; the abort is the
    /// cause, packages may be partially applied.
    Interrupted(CheckResult),
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

    checkpoint!(timeout);

    match tx.commit().err().map(|e| e.to_string()) {
        None => Ok(SysupgradeOutcome::Upgraded { packages }),
        Some(e) => Ok(classify_commit_error(
            check_cancel(timeout),
            flags.map(|f| f.reasons()).filter(|r| !r.is_empty()),
            e,
        )),
    }
}

/// Cancel/timeout outranks intervention outranks plain failure: a pending
/// abort is what made commit fail (the error text carries no reliable
/// keyword), and ImportKey fires inside trans_commit, so a refused key is
/// only visible here.
fn classify_commit_error(
    check: CheckResult,
    intervention: Option<Vec<&'static str>>,
    error: String,
) -> SysupgradeOutcome {
    match check {
        CheckResult::Continue => match intervention {
            Some(reasons) => SysupgradeOutcome::Intervention {
                reasons,
                error: Some(error),
            },
            None => SysupgradeOutcome::CommitFailed(error),
        },
        r => SysupgradeOutcome::Interrupted(r),
    }
}

#[cfg(test)]
mod tests {
    use super::{InterventionFlags, SysupgradeOutcome, classify_commit_error};
    use crate::util::CheckResult;
    use std::sync::atomic::Ordering;

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
    fn commit_error_classification_precedence() {
        let reasons = || Some(vec!["key imports required"]);

        assert_eq!(
            classify_commit_error(CheckResult::Cancelled, reasons(), "err".into()),
            SysupgradeOutcome::Interrupted(CheckResult::Cancelled)
        );
        assert_eq!(
            classify_commit_error(CheckResult::TimedOut(300), reasons(), "err".into()),
            SysupgradeOutcome::Interrupted(CheckResult::TimedOut(300))
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
