use alpm::{Alpm, TransFlag};
use anyhow::Result;

use crate::models::{BlockedBy, ConflictInfo, PrepareFailure};

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

    pub fn prepare(&mut self) -> Result<(), String> {
        self.prepare_detailed().map_err(|f| f.to_string())
    }

    /// PrepareError's Display is only alpm's errno line ("could not satisfy
    /// dependencies"); the packages that caused it are in the error data.
    pub fn prepare_detailed(&mut self) -> Result<(), PrepareFailure> {
        self.handle.trans_prepare().map_err(|e| {
            let mut failure = PrepareFailure {
                message: e.to_string(),
                ..Default::default()
            };
            match e.data() {
                Some(alpm::PrepareData::UnsatisfiedDeps(list)) => {
                    failure.unsatisfied = list
                        .iter()
                        .map(|m| BlockedBy {
                            target: m.target().to_string(),
                            depend: m.depend().to_string(),
                            causing: m.causing_pkg().map(|c| c.to_string()),
                        })
                        .collect();
                }
                Some(alpm::PrepareData::ConflictingDeps(list)) => {
                    failure.conflicting = list
                        .iter()
                        .map(|c| ConflictInfo {
                            package1: c.package1().name().to_string(),
                            package2: c.package2().name().to_string(),
                        })
                        .collect();
                }
                Some(alpm::PrepareData::PkgInvalidArch(list)) => {
                    failure.invalid_arch = list.iter().map(|p| p.name().to_string()).collect();
                }
                None => {}
            }
            failure
        })
    }

    pub fn commit(&mut self) -> Result<()> {
        if self
            .add()
            .iter()
            .any(|pkg| pkg.origin() == alpm::PackageFrom::SyncDb)
        {
            crate::network::require_network()?;
        }
        // Interrupting libalpm can skip post hooks after pre hooks changed boot files.
        self.handle
            .trans_commit()
            .map_err(|error| anyhow::anyhow!("{error}"))
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
