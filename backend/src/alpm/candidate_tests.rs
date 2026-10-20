use super::{find_available_updates, find_upgrade_candidate};
use alpm::{Alpm, SigLevel, Usage};
use anyhow::{Context, Result};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture(PathBuf);

impl Fixture {
    fn new(installed: &str, repositories: &[(&str, &str, &str)]) -> Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let fixture = Self(std::env::temp_dir().join(format!(
            "cpac-upgrade-candidate-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )));
        let local = fixture.0.join("db/local");
        std::fs::create_dir_all(&local)?;
        std::fs::create_dir_all(fixture.0.join("db/sync"))?;
        std::fs::write(local.join("ALPM_DB_VERSION"), "9\n")?;
        let directory = local.join(format!("widget-{installed}"));
        std::fs::create_dir(&directory)?;
        std::fs::write(
            directory.join("desc"),
            format!("%NAME%\nwidget\n\n%VERSION%\n{installed}\n\n%ARCH%\nany\n\n%REASON%\n0\n\n"),
        )?;
        std::fs::write(directory.join("files"), "")?;
        for (repo, name, version) in repositories {
            let directory = fixture.0.join(repo);
            let entry = format!("{name}-{version}");
            let package = directory.join(&entry);
            std::fs::create_dir_all(&package)?;
            std::fs::write(
                package.join("desc"),
                format!(
                    "%NAME%\n{name}\n\n%VERSION%\n{version}\n\n%ARCH%\nany\n\n\
                 %FILENAME%\n{name}-{version}-any.pkg.tar.zst\n\n%CSIZE%\n100\n\n%ISIZE%\n200\n\n"
                ),
            )?;
            let status = Command::new("tar")
                .args(["-cf"])
                .arg(fixture.0.join(format!("db/sync/{repo}.db")))
                .arg("-C")
                .arg(directory)
                .arg("--")
                .arg(entry)
                .status()?;
            anyhow::ensure!(status.success(), "Cannot create repository fixture");
        }
        Ok(fixture)
    }

    fn handle(&self, repositories: &[(&str, Usage)]) -> Result<Alpm> {
        let database = self.0.join("db");
        let handle = Alpm::new(
            self.0.to_str().context("Invalid fixture root")?,
            database.to_str().context("Invalid fixture database")?,
        )?;
        for (repo, usage) in repositories {
            handle
                .register_syncdb(*repo, SigLevel::NONE)?
                .set_usage(*usage)?;
        }
        Ok(handle)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_lower_priority_repository_does_not_override_an_older_candidate() -> Result<()> {
    let fixture = Fixture::new(
        "2-1",
        &[("core", "widget", "1-1"), ("extra", "widget", "3-1")],
    )?;
    let handle = fixture.handle(&[("core", Usage::ALL), ("extra", Usage::ALL)])?;
    let candidate = find_upgrade_candidate(&handle, "widget").context("Missing candidate")?;
    assert_eq!(candidate.version().as_str(), "1-1");
    assert!(find_available_updates(&handle, &[]).is_empty());
    Ok(())
}

#[test]
fn repositories_without_upgrade_usage_do_not_supply_candidates() -> Result<()> {
    let fixture = Fixture::new(
        "1-1",
        &[("search", "widget", "9-1"), ("core", "widget", "2-1")],
    )?;
    let handle = fixture.handle(&[
        ("search", Usage::SEARCH | Usage::INSTALL),
        ("core", Usage::UPGRADE),
    ])?;
    let updates = find_available_updates(&handle, &[]);
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].new_version, "2-1");
    assert_eq!(updates[0].repository, "core");
    Ok(())
}

#[test]
fn search_only_and_missing_packages_have_no_candidate() -> Result<()> {
    let fixture = Fixture::new(
        "1-1",
        &[("search", "widget", "2-1"), ("extra", "other", "3-1")],
    )?;
    let handle = fixture.handle(&[("search", Usage::SEARCH), ("extra", Usage::UPGRADE)])?;
    assert!(find_upgrade_candidate(&handle, "widget").is_none());
    assert!(find_upgrade_candidate(&handle, "absent").is_none());
    assert!(find_available_updates(&handle, &[]).is_empty());
    Ok(())
}

#[test]
fn a_package_absent_from_the_first_repository_can_use_the_next() -> Result<()> {
    let fixture = Fixture::new(
        "1-1",
        &[("core", "other", "3-1"), ("extra", "widget", "2-1")],
    )?;
    let handle = fixture.handle(&[("core", Usage::ALL), ("extra", Usage::ALL)])?;
    let candidate = find_upgrade_candidate(&handle, "widget").context("Missing candidate")?;
    assert_eq!(candidate.db().context("Missing database")?.name(), "extra");
    Ok(())
}

#[test]
fn ignored_packages_keep_their_candidate_and_update_is_marked_held() -> Result<()> {
    let fixture = Fixture::new("1-1", &[("core", "widget", "2-1")])?;
    let mut handle = fixture.handle(&[("core", Usage::ALL)])?;
    let ignored = vec!["widget".to_string()];
    assert!(find_available_updates(&handle, &ignored)[0].ignored);
    handle.add_ignorepkg("widget")?;
    assert!(find_upgrade_candidate(&handle, "widget").is_some());
    assert!(find_available_updates(&handle, &[])[0].ignored);
    Ok(())
}
