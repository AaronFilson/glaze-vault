# Sharing a vault with others

A vault is for one person until you share it. Sharing lets other people sign in on the same
computer with their own passwords, and you decide what each of them can see and change. Each
person's recipes are encrypted so that only the people allowed can open them.

> Other computers on your network come later. For now, everyone signs in on the computer the
> vault is on.

## Sharing your vault

1. Open **Settings**. Under **Sharing**, type your name as others will see it, and choose
   **Share this vault…**, then **Share this vault**.
2. Glaze Vault shows the **organization's recovery key**: 24 words, like your own recovery key,
   but for the whole vault. If every admin loses both their password and their recovery sheet,
   these words are the only way back in to everyone's recipes. Print it, or write it down, and
   keep it in a safe, away from the computer. Anyone who has it can open everything.
3. Type the three words it asks for, to show the sheet can be read.

You are now the vault's **admin**. Your recipes and materials are in a collection called
**Shared**, and you have a **Private** collection too. The lists show recipes under the name of
their collection.

Going back to one person is not in this version yet.

## Collections

A collection is a set of recipes and materials that are shared the same way: "Production",
"R&D", or one for each customer. Everyone also has a private collection, which only they and
admins can open.

When you make a new recipe or material, **Save in** says which collection it goes into. A
recipe stays in its collection when it is changed. Imports go into the collection chosen on the
import screen.

Admins add collections at the bottom of **Settings** › **People**, and rename them there.

## Adding someone

In **Settings** › **People**, under **Add someone**, type their name and a one-time password, and
choose **Add**. Tell them the one-time password.

When they first sign in, they choose their name on the lock screen, type the one-time password,
choose their own password, and get their own recovery sheet. So nobody else ever knows the
password they use. Until then, they can open nothing, and the people list says
*not signed in yet*.

Then give them a role on each shared collection, in the table:

| Role | Can |
|---|---|
| No access | Nothing in that collection. |
| Chemist: reads | Read its recipes and materials, and their chemistry. |
| Formulator: changes | Also make, change, delete and erase them. |
| Admin | Everything, in every collection, and people, collections and backups. |

Someone who can only read a recipe sees it with its fields greyed out, and no **Save** or
**Delete…**.

## Signing in

When a vault is shared, the lock screen asks for your name first. It remembers the last name
chosen on this computer.

## When someone leaves, or loses their password

- **Remove…** takes a person out. They can no longer sign in. Every collection they could open
  gets a new key and is encrypted again, and so does the vault, since they may have kept a copy.
  This takes a moment. Their private collection stays, for admins, listed as *From* their name.
- **Reset password…** is for someone who has lost both their password and their recovery
  sheet. Give them a new one-time password; they choose their own when they next sign in, and get
  a new recovery sheet. Their old sheet stops working.
- A person who still has their recovery sheet uses **Forgot your password?** on the lock screen,
  as on a vault for one.
- Taking a role away gives that collection a new key too.

## More than one admin

**Make admin…** makes someone an admin. Admins can do everything, so choose them with care: in
this version an admin cannot be made an ordinary member again, or removed. That needs a new
organization key, which comes later.

## If every admin is locked out

On the lock screen choose **Forgot your password?**, then **Use the organization's recovery key**.
Choose the admin to get back in, type the 24 words from the organization's sheet, and a new
password. That admin gets a new recovery sheet of their own, to print.

## Backups

Only admins back up a shared vault, since a backup holds every collection, and only an admin
restores one: **Restore from a backup** asks which admin is restoring, and takes their password,
their recovery key, or the organization's recovery key. See [Backups](backups.md).
