# Who did what: signatures and the audit log

Glaze Vault keeps a record of who saved each recipe revision, and a log of what everyone did in
the vault. In a shared vault, admins read the log; in a vault for one, you do.

## Who saved a revision

Every revision is signed by the person who saved it, with a key of their own made from their
password-protected keys. In a shared vault, a recipe's **Earlier revisions** list says who saved
each one, and:

- **moved by** someone, when a revision was moved to another collection after it was saved;
- **vouched for by** an admin, when it was saved before Glaze Vault signed revisions: the first
  admin to unlock the vault after the update vouches for everything saved before;
- **signed with a key no admin has certified yet**, for someone who joined before the update, until
  an admin next unlocks the vault and certifies their key.

If a revision says **changed outside the app: its signature does not match**, something in the
vault's files was changed without Glaze Vault: who saved it, when, or what it says. Look at it with
care, and restore a backup if you are unsure. Only someone who can unlock the vault can make such a
change, so ask who could have.

## The audit log

In **Settings**, **Audit log**, choose **Show the audit log**. The newest entries come first, with
when, who and what:

- each save, delete, erase and move of a record, and each photo added;
- each change to people, roles and collections;
- each sign-in, password change and new recovery key, and each backup made or restored;
- each record opened (once each time someone signs in), printed and exported.

**Export the whole log (CSV)** saves every entry as a spreadsheet, with the names you can see and
the ids behind them.

The log keeps ids, never what a recipe says. A record you cannot open, or one that was erased, is
shown by the start of its id. Erasing a record does not remove its entries from the log.

### What the log can and cannot tell you

- **Opening, printing and exporting** are what Glaze Vault reports. They show what the app did, not
  proof of what someone read: anyone who can see a recipe can copy it from the screen.
- **A wrong password** is not logged: the log is inside the vault it could not open.
- **Each entry is chained to the one before** and signed by the person it names. If entries were
  changed, taken out or put in outside the app, the log says so at the top. On one computer,
  someone who can unlock the vault could still rewrite the log as a whole; it shows what happened,
  but it is not proof against an admin.

> Coming later: with a computer on your network that hosts the vault, the host keeps the log and
> signs it, so it no longer depends on any one computer.
