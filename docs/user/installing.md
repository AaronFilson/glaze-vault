# Installing Glaze Vault

> Installers are not published yet. When they are, this page will link to them. Until then, Glaze
> Vault runs from its source code (see the project's main README).

Glaze Vault will be an ordinary application on each system, with nothing else to install: the
database, the encryption and the calculator are all inside it.

| System  | Installer                                   | Supported                        |
| ------- | ------------------------------------------- | -------------------------------- |
| macOS   | `.dmg`: drag Glaze Vault into Applications  | macOS 10.15 and later            |
| Windows | `.msi` or `.exe` setup                      | Windows 10 and 11                |
| Linux   | `.deb`, `.rpm` or `.AppImage`               | Current Debian, Ubuntu, Fedora   |

## Where your vault is kept

Your vault is two files, `vault.db` and `vault.keys`, in a folder named `vault` in Glaze Vault's
own data folder:

| System  | Folder                                                            |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/com.glazecalcapp.vault/vault`      |
| Windows | `%LOCALAPPDATA%\com.glazecalcapp.vault\vault`                     |
| Linux   | `~/.local/share/com.glazecalcapp.vault/vault`                     |

Both files are needed to open the vault, and both are useless without your password or recovery
key. Do not move or edit them while Glaze Vault is open.

## Uninstalling

Removing the application does not remove your vault, so a reinstall finds it again. To remove
your recipes for good, delete the `vault` folder above as well.
