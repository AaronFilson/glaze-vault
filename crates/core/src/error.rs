/// What can go wrong. The app shows the `Display` text, so it is written for the person using it,
/// and `code()` gives the UI something stable to match on.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("That password is not right.")]
    WrongPassword,
    #[error("That recovery key is not right. Check each word against your recovery sheet.")]
    WrongRecoveryKey,
    #[error("The password needs at least {0} characters.")]
    PasswordTooShort(usize),
    #[error("There is already a vault here.")]
    VaultExists,
    #[error("There is no vault here yet.")]
    NoVault,
    #[error("That recipe or material was not found.")]
    NotFound,
    #[error("Only a deleted recipe or material can be erased. Delete it first.")]
    NotDeleted,
    #[error("That recipe is too large to save.")]
    TooLarge,
    #[error("That file is not a Glaze Vault backup.")]
    NotABackup,
    #[error("The backup file is damaged or was changed, so it cannot be restored. Try another copy.")]
    BackupDamaged,
    #[error("That backup was made by a newer version of Glaze Vault. Update the app, then restore it.")]
    NewerBackup,
    #[error("{0}")]
    InvalidSetting(&'static str),
    #[error("The vault's files do not match each other: {0}")]
    Corrupt(String),
    #[error("The vault could not be read or written: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("A file could not be read or written: {0}")]
    Io(#[from] std::io::Error),
    #[error("A record could not be read: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::WrongPassword => "wrong-password",
            Error::WrongRecoveryKey => "wrong-recovery-key",
            Error::PasswordTooShort(_) => "password-too-short",
            Error::VaultExists => "vault-exists",
            Error::NoVault => "no-vault",
            Error::NotFound => "not-found",
            Error::NotDeleted => "not-deleted",
            Error::TooLarge => "too-large",
            Error::NotABackup => "not-a-backup",
            Error::BackupDamaged => "backup-damaged",
            Error::NewerBackup => "newer-backup",
            Error::InvalidSetting(_) => "invalid-setting",
            Error::Corrupt(_) => "corrupt",
            Error::Storage(_) => "storage",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
