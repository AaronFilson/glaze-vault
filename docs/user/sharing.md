# Sharing a vault with others

A vault is for one person until you share it. Sharing lets other people sign in on the same
computer with their own passwords, and you decide what each of them can see and change. Each
person's recipes are encrypted so that only the people allowed can open them.

> An admin can now [serve the vault on your network](hosting.md) from one computer. Joining it
> from the others comes in the next version; until then, everyone signs in on the computer the
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

To move a recipe, open it and choose a collection under **Move to**, then **Move…**. It goes with
all its revisions, firings, photos and batch sheet, and is encrypted again for its new
collection: people who could open the old one but not the new one stop seeing it. You need to be
able to change recipes in both.

A material moves the same way, from **Move to** below it, if you can change materials in both.
Recipes find materials by name, so a recipe in another collection that uses it is worked out
without it, or with the standard material of that name, for people who cannot open where it
went. Glaze Vault says how many recipes that is before it moves.

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
| Batch operator: weighs | Its batch sheets, and logging [mixes](mix-log.md) of them, and nothing else: no recipes, materials or chemistry. |
| Chemist: reads | Read its recipes and materials, and their chemistry. |
| Tester: logs firings | Read as a chemist does, and log firings with their photos, and mixes. |
| Formulator: changes | Also make, change, delete and erase them. |
| Admin | Everything, in every collection, and people, collections and backups. |

Someone who can only read a recipe sees it with its fields greyed out, and no **Save** or
**Delete…**.

### Your own roles

Under **Roles**, below the people, an admin can make roles of their own: a name, what it
changes, out of recipes, materials, batch sheets, firings, mixes, limit formulas and prices, and
what else it **May** do. *Costing* might change only prices; *Glaze tester* firings and limit
formulas. Give it to people in the table like any other role.

- **Reads recipes' chemistry**, ticked at first, reads everything in its collections, as a chemist
  does. Without it, a role sees each recipe's name and details, such as its type, cone and color,
  and its firings and their photos, but not its materials, amounts or notes, and no materials,
  limit formulas, prices or batch sheets. It can log firings, and change nothing else. This is
  kept by keys: its people are given a key that opens only those, not the recipes themselves.
- **Exports** and **Prints**, ticked at first: without them, its people have no export or print
  buttons for its collections. Anyone who can read a recipe can still copy it off the screen,
  so treat these as guard rails, not locks.
- **Manages people on its collections:** its people can give and take away roles on the
  collections it is given on, in **Settings** › **People**: any role but an admin's or another
  manager's, to anyone but an admin or another manager. Taking a role away gives the collection
  a new key, as when an admin does. They can rename those collections there too. Adding people
  to the vault stays with admins. A role that manages must read chemistry.

Changing a role changes it for everyone who has it, from their next sign-in. Taking **Reads
recipes' chemistry** away from a role gives every collection it is on a new key, since its
people held the old one. A role can be deleted once nobody has it.

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
  gets a new key, and so does the vault, since they may have kept a copy: what is saved from then
  on is out of their reach. What they could already read is not encrypted again, since they may
  have seen it already. Their private collection stays, for admins, listed as *From* their name.
- **Reset password…** is for someone who has lost both their password and their recovery
  sheet. Give them a new one-time password; they choose their own when they next sign in, and get
  a new recovery sheet. Their old sheet stops working.
- A person who still has their recovery sheet uses **Forgot your password?** on the lock screen,
  as on a vault for one.
- Taking a role away gives that collection a new key too.

## More than one admin

**Make admin…** makes someone an admin. Admins can do everything, so choose them with care.

**Take admin away…** makes an admin an ordinary member again, keeping their roles on collections.
An admin could open every collection, so the organization gets a new key and every collection a
new one, and then Glaze Vault shows the new **organization recovery
sheet** to print and check. The old sheet stops working: put it out of use. **Remove…** on an
admin does the same first, then removes them.

If the organization's sheet is lost, **New organization recovery sheet…** makes a new one to
print; the old one stops working. Nobody can take admin away from themselves, so there is always
an admin left.

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
