use alpm::{Alpm, TransFlag};
use anyhow::Result;
pub struct TransactionGuard<'a> {
    handle: &'a mut Alpm,
}

impl<'a> TransactionGuard<'a> {
    pub fn new(handle: &'a mut Alpm, flags: TransFlag) -> Result<Self> {
        handle
            .trans_init(flags)
            .map_err(|e| anyhow::anyhow!("Failed to initialize transaction: {}", e))?;
        Ok(Self { handle })
    }

    pub fn sync_sysupgrade(&mut self, enable_downgrade: bool) -> Result<(), alpm::Error> {
        self.handle.sync_sysupgrade(enable_downgrade)
    }

    /// PrepareError's Display is only alpm's errno line ("could not satisfy
    /// dependencies"); the packages that caused it are in the error data.
    pub fn prepare(&mut self) -> Result<(), String> {
        self.handle.trans_prepare().map_err(|e| {
            let mut msg = e.to_string();
            match e.data() {
                Some(alpm::PrepareData::UnsatisfiedDeps(list)) => {
                    for m in list {
                        msg.push_str(&format!("; {} requires {}", m.target(), m.depend()));
                        if let Some(cause) = m.causing_pkg() {
                            msg.push_str(&format!(" (removed by {})", cause));
                        }
                    }
                }
                Some(alpm::PrepareData::ConflictingDeps(list)) => {
                    for c in list {
                        msg.push_str(&format!(
                            "; {} conflicts with {}",
                            c.package1().name(),
                            c.package2().name()
                        ));
                    }
                }
                Some(alpm::PrepareData::PkgInvalidArch(list)) => {
                    for p in list {
                        msg.push_str(&format!("; {} is for another architecture", p.name()));
                    }
                }
                None => {}
            }
            msg
        })
    }

    pub fn commit(&mut self) -> Result<(), alpm::CommitError> {
        // Interrupting libalpm can skip post hooks after pre hooks changed boot files.
        self.handle.trans_commit()
    }

    pub fn add(&self) -> alpm::AlpmList<'_, &alpm::Package> {
        self.handle.trans_add()
    }

    pub fn remove(&self) -> alpm::AlpmList<'_, &alpm::Package> {
        self.handle.trans_remove()
    }

    pub fn localdb(&self) -> &alpm::Db {
        self.handle.localdb()
    }

    pub fn syncdbs(&self) -> alpm::AlpmList<'_, &alpm::Db> {
        self.handle.syncdbs()
    }

    pub fn load_pkg(
        &self,
        path: &str,
        level: alpm::SigLevel,
    ) -> Result<alpm::LoadedPackage<'_>, alpm::Error> {
        self.handle.pkg_load(path, true, level)
    }

    pub fn add_pkg<P: alpm::IntoPkgAdd>(&self, pkg: P) -> Result<(), alpm::AddError<P>> {
        self.handle.trans_add_pkg(pkg)
    }

    pub fn remove_pkg(&self, pkg: &alpm::Package) -> Result<(), alpm::Error> {
        self.handle.trans_remove_pkg(pkg)
    }
}

impl Drop for TransactionGuard<'_> {
    fn drop(&mut self) {
        let _ = self.handle.trans_release();
    }
}
