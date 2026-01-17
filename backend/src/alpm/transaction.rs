use alpm::{Alpm, TransFlag};
use anyhow::{Context, Result};

pub struct TransactionGuard<'a> {
    handle: &'a mut Alpm,
}

impl<'a> TransactionGuard<'a> {
    pub fn new(handle: &'a mut Alpm, flags: TransFlag) -> Result<Self> {
        handle
            .trans_init(flags)
            .context("Failed to initialize transaction")?;
        Ok(Self { handle })
    }

    pub fn sync_sysupgrade(&mut self, enable_downgrade: bool) -> Result<(), alpm::Error> {
        self.handle.sync_sysupgrade(enable_downgrade)
    }

    pub fn prepare(&mut self) -> Result<(), alpm::PrepareError<'_>> {
        self.handle.trans_prepare()
    }

    pub fn commit(&mut self) -> Result<(), alpm::CommitError> {
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

    pub fn remove_pkg(&mut self, pkg: &alpm::Package) -> Result<(), alpm::Error> {
        self.handle.trans_remove_pkg(pkg)
    }
}

impl Drop for TransactionGuard<'_> {
    fn drop(&mut self) {
        let _ = self.handle.trans_release();
    }
}
