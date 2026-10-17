//! Writing files so that a crash leaves the old file or the new one, never half of each.

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Writes a temporary file beside `path`, flushes it to disk, and renames it over `path`.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomically_with(path, |file| file.write_all(bytes))
}

/// As [`write_atomically`], with `write` writing the file a piece at a time.
pub fn write_atomically_with(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let temp = temporary(path);
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        write(&mut file)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn temporary(path: &Path) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(".tmp");
    PathBuf::from(name)
}
