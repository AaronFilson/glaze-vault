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

You can go back to one person later: see [Going back to one person](#going-back-to-one-person).

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
| Batch operator: weighs | Its batch sheets, and nothing else: no recipes, materials or chemistry. |
| Chemist: reads | Read its recipes and materials, and their chemistry. |
| Formulator: changes | Also make, change, delete and erase them. |
| Admin | Everything, in every collection, and people, collections and backups. |

Someone who can only read a recipe sees it with its fields greyed out, and no **Save** or
**Delete…**.

## Batch sheets

A batch sheet is for weighing out a recipe without seeing it: its materials go by your own codes,
such as M-104, and there is no unity formula, analysis or note from the recipe. It still shows how
much of each to weigh, so the proportions can be worked out from it; the names of the materials
and the chemistry cannot.

To make one, open a saved recipe you may change, and choose **Batch sheet…** below it. Type a
code for each material (the codes you have used before are filled in), a name for the sheet, and
any notes for weighing, such as "Sieve through 80 mesh", then **Save batch sheet**. A code stands
for one material: Glaze Vault says so if you give one code to two.

When you change the recipe, the sheet stays as it was, and the recipe says *Its batch sheet was
made from revision …*. Choose **Batch sheet…** again to bring it up to date.

**Batch sheets**, at the top, lists the sheets you can open. Choose one, type the batch size, and
**Print** it, with its running totals and a place to sign. Someone who is a batch operator in
every shared collection they have starts there.

The sheets are encrypted with a key of their own, made from the collection's key. A batch
operator is given only that key, which does not open the recipes, so they cannot be read whatever
is done to the app. Making someone a batch operator who could read more gives the collection a
new key, as taking a role away does.

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

## Going back to one person

An admin can make the vault theirs alone again: at the bottom of **Settings** › **People**,
choose **Go back to one person…**, then **Go back to one person**.

- First, a backup of the vault as it is is made in the vault's folder, named
  `before-one-person-…`, in case you need to go back. Settings says where it is.
- Everyone else is removed. What was in their private collections stays, in collections named
  *From* them.
- The organization key goes, so the organization recovery sheet stops working. Every collection,
  and the vault, get new keys, so your password and your recovery key are once more the only ways
  in.
- The lock screen no longer asks for a name.

You can share the vault again at any time; your private collection is kept.

## Backups

Only admins back up a shared vault, since a backup holds every collection, and only an admin
restores one: **Restore from a backup** asks which admin is restoring, and takes their password,
their recovery key, or the organization's recovery key. While a shared vault is on the computer,
no other backup can replace it except by one of its admins, and only a signed-in admin can switch
to a vault a restore set aside. See [Backups](backups.md).
