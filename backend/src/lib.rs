#![warn(clippy::unwrap_used, clippy::expect_used)]

pub mod alpm;
pub mod config;
pub mod db;
pub mod handlers;
pub mod models;
pub mod util;
pub mod validation;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
