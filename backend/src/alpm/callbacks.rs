use alpm::{Alpm, AnyDownloadEvent, DownloadEvent, LogLevel};
use std::collections::HashMap;

use crate::models::StreamEvent;
use crate::util::{emit_event, may_interrupt_transaction};

use super::log_level_to_string;

pub fn interrupt_if_cancelled() {
    if may_interrupt_transaction() {
        super::try_interrupt();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Verbosity {
    Streaming,
    Journal,
}

fn worth_emitting(level: LogLevel) -> bool {
    !matches!(log_level_to_string(level), "debug" | "function")
}

pub fn setup_log_cb(handle: &mut Alpm) {
    handle.set_log_cb((), move |level: LogLevel, msg: &str, _: &mut ()| {
        // The re-arm has to happen for every callback, including the ones whose
        // message is dropped: it is the only cancel path during downloads.
        interrupt_if_cancelled();
        if !worth_emitting(level) {
            return;
        }
        emit_event(&StreamEvent::Log {
            level: log_level_to_string(level).to_string(),
            message: msg.trim().to_string(),
        });
    });
}

fn percent_of(downloaded: i64, total: i64) -> Option<u8> {
    (total > 0).then(|| ((downloaded.max(0) as f64 / total as f64) * 100.0).round() as u8)
}

pub fn setup_dl_cb(handle: &mut Alpm, verbosity: Verbosity) {
    let mut last_percent: HashMap<String, u8> = HashMap::new();

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

            if event_str == "progress" {
                if verbosity == Verbosity::Journal {
                    return;
                }
                if let Some(pct) = downloaded.zip(total).and_then(|(d, t)| percent_of(d, t)) {
                    if last_percent.get(filename) == Some(&pct) {
                        return;
                    }
                    last_percent.insert(filename.to_string(), pct);
                }
            } else if event_str == "completed" {
                last_percent.remove(filename);
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

#[cfg(test)]
mod tests {
    use super::{LogLevel, percent_of, worth_emitting};

    #[test]
    fn an_error_or_a_warning_is_never_withheld() {
        assert!(worth_emitting(LogLevel::ERROR));
        assert!(worth_emitting(LogLevel::WARNING));
    }

    #[test]
    fn alpm_tracing_is_withheld() {
        assert!(!worth_emitting(LogLevel::DEBUG));
        assert!(!worth_emitting(LogLevel::FUNCTION));
    }

    #[test]
    fn percent_spans_zero_to_a_hundred() {
        assert_eq!(percent_of(0, 200), Some(0));
        assert_eq!(percent_of(199, 200), Some(100));
        assert_eq!(percent_of(200, 200), Some(100));
    }

    #[test]
    fn chunks_within_one_percent_share_a_value() {
        assert_eq!(percent_of(1000, 100_000), percent_of(1004, 100_000));
        assert_ne!(percent_of(1000, 100_000), percent_of(1600, 100_000));
    }

    #[test]
    fn an_unknown_total_has_no_percent() {
        assert_eq!(percent_of(50, 0), None);
        assert_eq!(percent_of(50, -1), None);
    }
}
