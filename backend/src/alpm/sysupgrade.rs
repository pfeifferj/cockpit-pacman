use alpm::{Alpm, AnyQuestion, Question, TransFlag};
use anyhow::Result;
use std::collections::HashSet;
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
/// callers pass their confirmed removal names, which are checked after prepare.
/// Callers hold a ShutdownInhibitor across this call and their result recording.
/// Err only when the transaction cannot be initialized.
pub fn run_sysupgrade(
    handle: &mut Alpm,
    timeout: &TimeoutGuard,
    flags: Option<&InterventionFlags>,
    approved_removals: Option<&[String]>,
    origin: crate::models::RunOrigin,
) -> Result<SysupgradeOutcome> {
    checkpoint!(timeout);

    let mut tx = TransactionGuard::new(handle, TransFlag::NONE)?;

    if let Err(e) = tx.sync_sysupgrade(false) {
        return Ok(SysupgradeOutcome::SyncFailed(e.to_string()));
    }

    checkpoint!(timeout);

    let prepare_err = tx.prepare().err();

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

    if let Some(approved) = approved_removals
        && let Err(error) =
            check_approved_removals(tx.remove().iter().map(|pkg| pkg.name()), approved)
    {
        return Ok(SysupgradeOutcome::PrepareFailed(error));
    }

    let packages = tx.add().len();
    if packages == 0 && tx.remove().is_empty() {
        return Ok(SysupgradeOutcome::NothingToDo);
    }

    checkpoint!(timeout);

    let run = crate::models::RunCommand {
        verb: "upgrade",
        targets: tx.add().iter().map(|pkg| pkg.name().into()).collect(),
        origin,
    };
    let commit_err = tx.commit_logged(&run).err().map(|e| e.to_string());
    let check = check_cancel(timeout);
    let intervention = flags.map(|f| f.reasons()).filter(|r| !r.is_empty());
    drop(tx);

    match commit_err {
        None => Ok(classify_commit_ok(check, packages)),
        Some(e) => Ok(classify_commit_error(check, intervention, e)),
    }
}

pub(crate) fn check_approved_removals<'a>(
    removals: impl Iterator<Item = &'a str>,
    approved: &[String],
) -> Result<(), String> {
    let approved: HashSet<&str> = approved.iter().map(String::as_str).collect();
    let mut unapproved: Vec<&str> = removals.filter(|name| !approved.contains(name)).collect();
    unapproved.sort_unstable();
    unapproved.dedup();
    if unapproved.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Transaction plan changed: removal of {} was not approved. Review the preview again before applying it.",
            unapproved.join(", ")
        ))
    }
}

fn classify_commit_ok(check: CheckResult, packages: usize) -> SysupgradeOutcome {
    match check {
        CheckResult::Cancelled => SysupgradeOutcome::CompletedDespiteCancel { packages },
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
    let error = if matches!(check, CheckResult::Cancelled) {
        format!("{error}. Cancellation was requested while committing")
    } else {
        error
    };
    match intervention {
        Some(reasons) => SysupgradeOutcome::Intervention {
            reasons,
            error: Some(error),
        },
        None => SysupgradeOutcome::CommitFailed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{InterventionFlags, SysupgradeOutcome, classify_commit_error, classify_commit_ok};
    use crate::util::CheckResult;
    use std::sync::atomic::Ordering;

    #[test]
    fn a_new_removal_requires_another_confirmation() {
        let error = super::check_approved_removals(
            ["old-driver", "newly-conflicting"].into_iter(),
            &["old-driver".to_string()],
        )
        .unwrap_err();
        assert!(error.contains("newly-conflicting"));
        assert!(!error.contains("old-driver"));
    }

    #[test]
    fn missing_consent_refuses_removals_but_allows_ordinary_upgrades() {
        assert!(super::check_approved_removals(["old-driver"].into_iter(), &[]).is_err());
        assert!(super::check_approved_removals(std::iter::empty(), &[]).is_ok());
        assert!(
            super::check_approved_removals(
                ["old-driver"].into_iter(),
                &["old-driver".to_string(), "unused-approval".to_string()],
            )
            .is_ok()
        );
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
    fn cancellation_after_commit_does_not_discard_completion() {
        assert_eq!(
            classify_commit_ok(CheckResult::Cancelled, 10),
            SysupgradeOutcome::CompletedDespiteCancel { packages: 10 }
        );
        assert_eq!(
            classify_commit_ok(CheckResult::Continue, 10),
            SysupgradeOutcome::Upgraded { packages: 10 }
        );
    }

    #[test]
    fn cancellation_preserves_commit_failure() {
        let outcome = classify_commit_error(CheckResult::Cancelled, None, "disk full".into());
        let SysupgradeOutcome::CommitFailed(error) = outcome else {
            panic!("{outcome:?}")
        };
        assert!(error.contains("disk full"));
    }

    #[test]
    fn intervention_preserves_commit_failure() {
        assert_eq!(
            classify_commit_error(
                CheckResult::Continue,
                Some(vec!["key imports required"]),
                "untrusted key".into()
            ),
            SysupgradeOutcome::Intervention {
                reasons: vec!["key imports required"],
                error: Some("untrusted key".into())
            }
        );
    }
}
