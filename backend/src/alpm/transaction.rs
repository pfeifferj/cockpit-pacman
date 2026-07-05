use alpm::{Alpm, TransFlag};
use anyhow::Result;
use std::cell::RefCell;
use std::ptr::NonNull;

thread_local! {
    // Only ever touched on the commit thread (guard setup/teardown and the alpm
    // callbacks that run inside trans_commit), so a thread-local cell needs no
    // Send/Sync and no lock.
    static INTERRUPT_HANDLE: RefCell<Option<NonNull<alpm_sys::alpm_handle_t>>> =
        const { RefCell::new(None) };
}

pub fn try_interrupt() {
    // Copy the pointer out and drop the borrow before the FFI call, so the cell
    // is free even if libalpm were ever to re-enter this thread.
    let ptr = INTERRUPT_HANDLE.with_borrow(|handle| *handle);
    if let Some(ptr) = ptr {
        // SAFETY: Drop clears the cell before trans_release, so a stashed
        // handle is always live here.
        unsafe {
            alpm_sys::alpm_trans_interrupt(ptr.as_ptr());
        }
    }
}

pub struct TransactionGuard<'a> {
    handle: &'a mut Alpm,
}

impl<'a> TransactionGuard<'a> {
    pub fn new(handle: &'a mut Alpm, flags: TransFlag) -> Result<Self> {
        handle
            .trans_init(flags)
            .map_err(|e| anyhow::anyhow!("Failed to initialize transaction: {}", e))?;
        let ptr = NonNull::new(handle.as_alpm_handle_t());
        INTERRUPT_HANDLE.with_borrow_mut(|h| *h = ptr);
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

    pub fn syncdbs(&self) -> alpm::AlpmList<'_, &alpm::Db> {
        self.handle.syncdbs()
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
        // Clear before trans_release: try_interrupt must not reach a freed handle.
        INTERRUPT_HANDLE.with_borrow_mut(|h| *h = None);
        let _ = self.handle.trans_release();
    }
}
