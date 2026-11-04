//! The host's secret at rest (docs/adr/0038-hardening-hostd.md). Everywhere it is `host.key`, in
//! a folder only the service's user can open. On Windows the installed service keeps it under
//! DPAPI as well, in `host.key.dpapi`, with the machine's key: hostd moves a plain `host.key` there
//! as it starts, so a copy of the folder taken off the computer does not carry the key.

use super::HostStore;
use super::host::HOST_KEY;
use crate::error::Result;
use std::path::Path;
use zeroize::Zeroizing;

/// The host's secret kept under DPAPI, beside where `host.key` was.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) const PROTECTED_KEY: &str = "host.key.dpapi";

/// The host's secret from the folder `dir`, under DPAPI or not.
pub(super) fn read(dir: &Path) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(windows)]
    {
        let protected = dir.join(PROTECTED_KEY);
        if protected.is_file() {
            return dpapi::unprotect(&std::fs::read(protected)?);
        }
    }
    Ok(Zeroizing::new(std::fs::read(dir.join(HOST_KEY))?))
}

impl HostStore {
    /// On Windows, moves a plain `host.key` in `dir` under DPAPI, and says whether it did. It is
    /// checked to open again before the plain file goes. Elsewhere it does nothing.
    pub fn protect_key(dir: &Path) -> Result<bool> {
        #[cfg(windows)]
        {
            let plain = dir.join(HOST_KEY);
            if !plain.is_file() {
                return Ok(false);
            }
            let secret = Zeroizing::new(std::fs::read(&plain)?);
            let protected = dpapi::protect(&secret)?;
            if dpapi::unprotect(&protected)?.as_slice() != secret.as_slice() {
                return Err(crate::error::Error::Corrupt(
                    "the host key did not come back from DPAPI".into(),
                ));
            }
            crate::files::write_atomically(&dir.join(PROTECTED_KEY), &protected)?;
            std::fs::remove_file(&plain)?;
            Ok(true)
        }
        #[cfg(not(windows))]
        {
            let _ = dir;
            Ok(false)
        }
    }
}

#[cfg(windows)]
mod dpapi {
    //! CryptProtectData with the machine's key: the service's virtual account and an elevated
    //! `hostd` (export, restore) both read it, and nothing on another computer does.

    use crate::error::{Error, Result};
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    use zeroize::Zeroizing;

    /// Ties the protected key to its use, so another program's blob is not taken for it.
    const ENTROPY: &[u8] = b"glaze-vault v1 host-key";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    /// Copies what DPAPI gave back, and frees it.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
        let bytes = Zeroizing::new(unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec());
        unsafe {
            ptr::write_bytes(out.pbData, 0, out.cbData as usize);
            LocalFree(out.pbData as _);
        }
        bytes
    }

    pub fn protect(secret: &[u8]) -> Result<Vec<u8>> {
        let (input, entropy) = (blob(secret), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let done = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if done == 0 {
            return Err(Error::Corrupt(format!(
                "DPAPI did not protect the host key: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(unsafe { take(out) }.to_vec())
    }

    pub fn unprotect(protected: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let (input, entropy) = (blob(protected), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let done = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if done == 0 {
            return Err(Error::Corrupt(format!(
                "the host key does not open with this computer's DPAPI key: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(unsafe { take(out) })
    }
}
