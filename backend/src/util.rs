use std::cmp::Ordering;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

use crate::models::StreamEvent;

static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn is_cancelled() -> bool {
    CANCELLED.load(AtomicOrdering::SeqCst)
}

pub fn setup_signal_handler() {
    static HANDLER_SET: AtomicBool = AtomicBool::new(false);

    if HANDLER_SET.load(AtomicOrdering::SeqCst) {
        return;
    }

    match ctrlc::set_handler(move || {
        CANCELLED.store(true, AtomicOrdering::SeqCst);
    }) {
        Ok(()) => {
            HANDLER_SET.store(true, AtomicOrdering::SeqCst);
        }
        Err(e) => {
            eprintln!("Warning: Failed to set signal handler: {}", e);
        }
    }
}

pub fn emit_event(event: &StreamEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        println!("{}", json);
        let _ = io::stdout().flush();
    }
}

pub fn sort_with_direction<T, F>(items: &mut [T], ascending: bool, cmp_fn: F)
where
    F: Fn(&T, &T) -> Ordering,
{
    items.sort_by(|a, b| {
        let cmp = cmp_fn(a, b);
        if ascending {
            cmp
        } else {
            cmp.reverse()
        }
    });
}
