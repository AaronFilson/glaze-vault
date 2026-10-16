# Backups and export

## Backing up

A backup is one file with every recipe in your vault, encrypted. Keep backups away from this
computer, on a USB drive or another computer, so a failed disk or a stolen laptop does not take
your recipes with it.

1. Open **Settings** and choose **Back up now…** under **Backups**.
2. Choose where to save it. The file is named like `Glaze Vault backup 2026-10-14.gvbackup`.

Settings shows when you last backed up. Save the backup to a USB drive or another computer, not
only to this one.

### What a backup opens with

A backup opens with **the password or recovery key your vault had on the day you made it**:

- If you change your password later, older backups still need the old password, or your
  recovery key.
- If you [make a new recovery key](recovery-key.md#making-a-new-recovery-key), older backups
  still open with the old recovery sheet. Make a new backup afterwards, and destroy older ones
  you no longer need.

Unsaved changes in the editor are not in a backup: save first.

### Reminders

If you have not backed up for a month, Glaze Vault reminds you at the top of the window. Choose
**Back up now…**, or **Not now** to hide it until you next unlock. To change how long it waits,
or turn reminders off, use **Remind me to back up** in **Settings**.

## Restoring a backup

Restore a backup to move your vault to a new computer, or to go back to how it was.

1. On the unlock screen (lock the vault first if it is open), or on the setup screen of a new
   installation, choose **Restore from a backup**.
2. Choose **Choose backup file…** and pick the `.gvbackup` file. Glaze Vault shows when it was
   made.
3. Type the password the vault had when the backup was made, and choose **Restore**. If you do
   not know that password, choose **Use the recovery key instead**, type the 24 words from the
   sheet you had then, and choose a new password.

Glaze Vault opens the backup and checks it before changing anything. A damaged or altered backup,
or a wrong password, leaves your vault as it was.

### The vault that was there before

If this computer already had a vault, restoring does not delete it. It is moved into a folder
named `replaced-` followed by a number, inside the
[vault folder](installing.md#where-your-vault-is-kept), and the restore screen shows where.

To go back to it:

1. Quit Glaze Vault.
2. In the vault folder, move `vault.db` and `vault.keys` into a new folder of their own, as a
   precaution.
3. Move `vault.db` and `vault.keys` out of the `replaced-…` folder, up into the vault folder.
4. Open Glaze Vault and unlock with that vault's password.

Once you are sure you do not need it, delete the `replaced-…` folder.

## Exporting recipes

Exports are for using your recipes in other programs: a spreadsheet, a costing sheet, another
glaze calculator.

**Exported files are not encrypted.** Anyone who gets the file can read every recipe in it. For a
safe copy, make a backup instead.

In **Settings**, under **Export**:

- **Export as CSV…** saves a spreadsheet: one row for each material in each recipe, with the
  recipe's name, the amount, its percentage of the recipe, and on each recipe's first row its
  notes, revision number and when it was saved. Excel, Numbers and LibreOffice open it directly.
- **Export as JSON…** saves the same recipes, and [your own materials](materials.md), for other
  programs. Its layout is described by its `"format": "glaze-vault-export"` and `"version": 1`
  fields.
- **Export materials as CSV…** saves your own materials as a spreadsheet: one row for each oxide,
  then the loss on ignition, with each material's kind, notes, revision and date on its first
  row.

Text in a recipe or material that a spreadsheet would treat as a formula (starting with `=`, `+`, `-` or `@`)
gets an apostrophe in front, so opening an export cannot run anything.
