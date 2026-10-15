# Installing Glaze Vault

Glaze Vault is an ordinary application on each system, with nothing else to install: the
database, the encryption and the calculator are all inside it. Download the installer for your
computer from the [releases page](https://github.com/AaronFilson/glaze-vault/releases).

> No release has been published yet. Until the first one, Glaze Vault runs from its source code
> (see the project's main README).

| System  | Installer                                                          | Supported                      |
| ------- | ------------------------------------------------------------------ | ------------------------------ |
| macOS   | `.dmg`: open it and drag Glaze Vault into Applications             | macOS 10.15 and later, Intel and Apple silicon |
| Windows | `-setup.exe` for yourself, or `.msi` for every user (needs an administrator) | Windows 10 and 11 |
| Linux   | `.AppImage` (runs anywhere), `.deb` (Debian, Ubuntu) or `.rpm` (Fedora) | Ubuntu 22.04 and later, current Debian and Fedora |

### If your computer warns about the installer

Early releases may not be signed by Apple or Microsoft yet. Then:

- **macOS** says it cannot check Glaze Vault for malicious software. Open **System Settings →
  Privacy & Security**, scroll down, and choose **Open Anyway** next to Glaze Vault, within an
  hour of trying to open it.
- **Windows** says **Windows protected your PC**. Choose **More info**, then **Run anyway**.

Only do this for an installer you downloaded from the releases page above.

## Updates

Glaze Vault checks for a new version when it starts, and offers it at the top of the window:
choose **Install and restart**. It never installs one without asking. See
[Settings](settings.md#updates) to check by hand or turn the check off.

## Where your vault is kept

Your vault is two files, `vault.db` and `vault.keys`, in a folder named `vault` in Glaze Vault's
own data folder:

| System  | Folder                                                            |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/com.glazecalcapp.vault/vault`      |
| Windows | `%LOCALAPPDATA%\com.glazecalcapp.vault\vault`                     |
| Linux   | `~/.local/share/com.glazecalcapp.vault/vault`                     |

Both files are needed to open the vault, and both are useless without your password or recovery
key. Do not move or edit them while Glaze Vault is open. The same folder also holds
`preferences.json` (whether to check for updates, nothing secret), and any `replaced-…` folders
left by [restoring a backup](backups.md#restoring-a-backup).

## Uninstalling

Removing the application does not remove your vault, so a reinstall finds it again. To remove
your recipes for good, delete the `vault` folder above as well.
