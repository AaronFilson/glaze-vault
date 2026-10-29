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
    #[error("You do not have permission to do that. An admin can change what you may do.")]
    NotAllowed,
    #[error("Choose your name first.")]
    ChooseName,
    #[error("That person is not in this vault.")]
    NoSuchPerson,
    #[error("Someone in this vault already has that name.")]
    NameTaken,
    #[error("Give a name, so others can tell who this is.")]
    NameMissing,
    #[error("This vault is not shared with others yet.")]
    NotATeam,
    #[error("This vault is already shared with others.")]
    AlreadyATeam,
    #[error("The vault on this computer is shared with others, so only one of its admins can replace it.")]
    NotAnAdminHere,
    #[error("That role is not in this vault.")]
    NoSuchRole,
    #[error("There is already a role with that name.")]
    RoleNameTaken,
    #[error("Some people have that role. Give them another before deleting it.")]
    RoleInUse,
    #[error("A role that reads recipes without their chemistry can log firings, and change and manage nothing else.")]
    ChemistryNeeded,
    #[error("An admin needs to unlock this vault once more before anyone can read it without chemistry.")]
    NotChangedOver,
    #[error("Only an admin can change an admin's roles, or a manager's.")]
    ManagersOnlyLower,
    #[error("Take admin away from them first: that gives the organization a new key and recovery sheet.")]
    RemovingAdmin,
    #[error("That person is not an admin.")]
    NotAnAdmin,
    #[error("This record changed again while you were choosing a version. Look again, then choose.")]
    ForkChanged,
    #[error("A signature does not match what it signs.")]
    BadSignature,
    #[error("This vault cannot serve the network yet: {0}")]
    NotReadyToHost(&'static str),
    #[error("This computer may no longer sync with the vault.")]
    Revoked,
    #[error("Deleting it has not reached the vault's host yet. Erase it once this computer has synced.")]
    NotSynced,
    #[error("This photo has not reached this computer yet. It comes with a sync.")]
    NotFetched,
    #[error("{0} is changing this on another computer. Wait until they are done, or take it over.")]
    CheckedOut(String),
    #[error("That needs the vault's host: connect this computer to its network, then try again.")]
    NeedsHost,
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
            Error::NotAllowed => "not-allowed",
            Error::ChooseName => "choose-name",
            Error::NoSuchPerson => "no-such-person",
            Error::NameTaken => "name-taken",
            Error::NameMissing => "name-missing",
            Error::NotATeam => "not-a-team",
            Error::AlreadyATeam => "already-a-team",
            Error::NotAnAdminHere => "not-an-admin-here",
            Error::NoSuchRole => "no-such-role",
            Error::RoleNameTaken => "role-name-taken",
            Error::RoleInUse => "role-in-use",
            Error::ChemistryNeeded => "chemistry-needed",
            Error::NotChangedOver => "not-changed-over",
            Error::ManagersOnlyLower => "managers-only-lower",
            Error::RemovingAdmin => "removing-admin",
            Error::NotAnAdmin => "not-an-admin",
            Error::ForkChanged => "fork-changed",
            Error::BadSignature => "bad-signature",
            Error::NotReadyToHost(_) => "not-ready-to-host",
            Error::Revoked => "revoked",
            Error::NotSynced => "not-synced",
            Error::NotFetched => "not-fetched",
            Error::CheckedOut(_) => "checked-out",
            Error::NeedsHost => "needs-host",
            Error::Corrupt(_) => "corrupt",
            Error::Storage(_) => "storage",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
