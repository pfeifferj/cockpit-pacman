use alpm::{Alpm, AnyDownloadEvent, DownloadEvent, LogLevel};

use crate::models::StreamEvent;
use crate::util::emit_event;

use super::log_level_to_string;

pub fn setup_log_cb(handle: &mut Alpm) {
    handle.set_log_cb((), |level: LogLevel, msg: &str, _: &mut ()| {
        emit_event(&StreamEvent::Log {
            level: log_level_to_string(level).to_string(),
            message: msg.trim().to_string(),
        });
    });
}

pub fn setup_dl_cb(handle: &mut Alpm) {
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
