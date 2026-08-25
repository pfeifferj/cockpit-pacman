use alpm::{Alpm, AnyDownloadEvent, DownloadEvent, LogLevel};

use crate::models::StreamEvent;
use crate::util::{emit_event, is_cancelled};

use super::log_level_to_string;

/// Re-arm from every callback: alpm only latches the interrupt in
/// STATE_COMMITTING, so a request during downloads has to be retried.
pub fn interrupt_if_cancelled() {
    if is_cancelled() {
        super::try_interrupt();
    }
}

/// A scheduled run has no client reading stdout, so events go to the journal,
/// where alpm's per-chunk tracing would blow past journald's rate limit and
/// drop the run's own diagnostics.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Verbosity {
    Streaming,
    Journal,
}

impl Verbosity {
    fn wants_level(self, level: LogLevel) -> bool {
        match self {
            Verbosity::Streaming => true,
            Verbosity::Journal => !matches!(log_level_to_string(level), "debug" | "function"),
        }
    }
}

pub fn setup_log_cb(handle: &mut Alpm, verbosity: Verbosity) {
    handle.set_log_cb((), move |level: LogLevel, msg: &str, _: &mut ()| {
        // The re-arm has to happen for every callback, including the ones whose
        // message is dropped: it is the only cancel path during downloads.
        interrupt_if_cancelled();
        if !verbosity.wants_level(level) {
            return;
        }
        emit_event(&StreamEvent::Log {
            level: log_level_to_string(level).to_string(),
            message: msg.trim().to_string(),
        });
    });
}

pub fn setup_dl_cb(handle: &mut Alpm, verbosity: Verbosity) {
    handle.set_dl_cb(
        (),
        move |filename: &str, event: AnyDownloadEvent, _: &mut ()| {
            interrupt_if_cancelled();
            let (event_str, downloaded, total) = match event.event() {
                DownloadEvent::Init(_) => ("init", None, None),
                DownloadEvent::Progress(p) => ("progress", Some(p.downloaded), Some(p.total)),
                DownloadEvent::Retry(_) => ("retry", None, None),
                DownloadEvent::Completed(c) => ("completed", None, Some(c.total)),
            };
            // Progress is per chunk; init, retry and completed are one line per file.
            if verbosity == Verbosity::Journal && event_str == "progress" {
                return;
            }
            emit_event(&StreamEvent::Download {
                filename: filename.to_string(),
                event: event_str.to_string(),
                downloaded,
                total,
            });
        },
    );
}
