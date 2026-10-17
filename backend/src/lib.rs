#![cfg_attr(not(test), warn(clippy::unwrap_used, clippy::expect_used))]

pub mod alpm;
pub mod backups;
pub mod config;
pub mod db;
mod endpoints;
pub mod handlers;
pub mod inhibit;
mod log_cache;
pub mod models;
pub mod network;
pub mod util;
pub mod validation;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
