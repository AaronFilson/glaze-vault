//! Where `log` writes: standard error, which launchd and systemd keep, or a file, for the Windows
//! service, which has none.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

struct Logger(Option<Mutex<File>>);

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        match &self.0 {
            Some(file) => {
                let at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                let mut file = file.lock().unwrap_or_else(|e| e.into_inner());
                let _ = writeln!(file, "{at} {} {}", record.level(), record.args());
            }
            None => eprintln!("{} {}", record.level(), record.args()),
        }
    }

    fn flush(&self) {}
}

fn set(logger: Logger) {
    let _ = log::set_boxed_logger(Box::new(logger)).map(|()| log::set_max_level(log::LevelFilter::Info));
}

pub fn stderr() {
    set(Logger(None));
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn file(path: &Path) {
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => set(Logger(Some(Mutex::new(file)))),
        Err(_) => stderr(),
    }
}
