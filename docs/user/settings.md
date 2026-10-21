# Settings

Choose **Settings** at the top of the window when the vault is open. Choose **Back to recipes**
to return; anything you were editing is still there.

## Sharing, or People

On a vault for one, **Sharing** lets others sign in with their own passwords. Once it is shared,
**People** is where admins add people, give them roles and make collections. See
[Sharing a vault with others](sharing.md).

## Locking by itself

**Lock the vault when Glaze Vault has not been used for a while** is on to begin with, and locks
after 15 minutes in which nobody has moved the mouse over Glaze Vault, clicked, typed or
scrolled in it. Choose from 1 minute
to 2 hours in **Lock after**, or untick it to turn it off.

Time with the computer asleep, or with Glaze Vault minimized, counts: coming back after longer
than that finds the vault locked.

Unsaved changes are kept, encrypted, and come back in the editor when you unlock (see
[Recipes](recipes.md#saving-and-revisions)). The unlock screen says why the vault
locked.

This setting is kept in your vault, so it comes with it when you
[restore a backup](backups.md#restoring-a-backup) on another computer.

## Backups and export

See [Backups and export](backups.md). In a shared vault, only admins see backups. **Vaults set aside** appears only when restoring a backup
has set a vault aside: see [the vault that was there before](backups.md#the-vault-that-was-there-before).

## Import

See [Importing](importing.md).

## Audit log

Who did what in the vault: for admins in a shared vault, and for you in a vault for one. See
[Who did what](audit-log.md).

## Password

Type your current password, then the new one twice, and choose **Change password**. Your
recovery key does not change. Backups made before still open with the old password (or your
recovery key).

## Recovery key

See [making a new recovery key](recovery-key.md#making-a-new-recovery-key).

## Updates

Settings shows which version of Glaze Vault this is.

- **Check for updates when Glaze Vault starts** is on to begin with. When there is a new version,
  Glaze Vault says so at the top of the window. Updates are only installed when you choose
  **Install and restart**.
- **Check now** checks straight away.

Checking asks GitHub for the newest version's number. Nothing from your vault is sent. A computer
with no internet connection simply hears nothing. Before installing, Glaze Vault checks that the
update is signed by Glaze Vault's own key, and locks the vault; it restarts on its own. On
Windows, an installer window may show its progress; if Glaze Vault was installed for every user,
Windows asks for an administrator.

If your organization installs software for you, it may have turned the check off, and will
install new versions itself.
