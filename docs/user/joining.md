# Joining a vault on your network

When an admin [serves the team's vault](hosting.md) from one computer, the team's other computers
can join it: a laptop, the computer by the kilns, a second studio desktop. Each keeps a copy of
what its people can see, and works on it whether or not the network is there.

## Joining

You need an admin nearby, or on the phone, and the computer that serves must be on.

1. Install Glaze Vault on the new computer and open it. Instead of setting up a vault, choose
   **Join a vault on this network**.
2. The hosts on your network are listed. Choose yours, or type its address, such as
   `192.168.1.20`, if none is listed: some networks hide computers from each other.
3. The admin chooses **Pair a computer…** in Settings, Network, and reads out the code that
   appears, such as `4821-0937`. Type it here.
4. Give this computer a name the admin will recognise, and choose **Join**.
5. The admin's screen shows this computer's name and a key such as `428b-ec49-9b19-3bd5`. Check
   together that it is the key this computer shows. The admin then ticks who will use this
   computer, and approves it.
6. Sign in with your own password, the one you use on the other computers. Only the people the
   admin ticked can sign in here. The first sync then brings what you may see, which can take a
   while for a large vault.

A code works once, for ten minutes. If it was typed wrongly, the admin starts again for a new one.

## Joining from a phone or tablet

A phone or tablet joins the same way, and can scan the code instead of typing it.

1. Install Glaze Vault on the phone and open it. Choose **Join a vault on this network**.
2. The admin chooses **Pair a computer…** in Settings, Network. Their screen shows the code and a
   square QR code beside it.
3. Choose **Scan the code** on the phone, and allow the camera when asked. Point it at the
   admin's screen.
4. On an iPhone or iPad, the first time, it asks whether Glaze Vault may find devices on your
   local network. Choose **Allow**: the vault's host is on your network, and nothing goes beyond
   it.
5. The admin checks the phone's key and approves it, as for a computer, and you sign in with your
   own password.

Scanning also checks that the phone reaches your vault's own host, and not some other computer
on the network: if it does not, the phone says so and nothing is sent.

If the camera cannot be used, type the host's address and the code, as on a computer. Phones do
not list the hosts on the network yet, so ask the admin for the address Settings shows.

**If an iPhone cannot reach the host**, and once said no to finding devices on the local network,
turn it on in **Settings, Privacy & Security, Local Network, Glaze Vault**, then try again.

### Give the host a fixed address

Phones find the host only by the address they joined with. If the host computer's address
changes, as some routers do when it restarts, phones stop syncing until it is back. Ask whoever
runs your network to give the host computer a fixed address (a "DHCP reservation" in most
routers' settings), or set one on the computer itself. Computers find the host by name anyway.

## Syncing

While you are signed in, Glaze Vault syncs with the host by itself: a few seconds after you save
something, as soon as someone saves on another computer, and every half minute anyway. You never
need to wait for it; you go on working while it syncs.

The bar at the top says how it stands, such as **Synced 10:32**, or **Not synced** when the host
is out of reach. Choose it for more, and for **Sync now**. While the host is out of reach,
everything works as before; what you save is kept, and sent when the host is back.

Photos come after the records they belong to, a piece at a time. One that has not come yet shows
**Photo not synced yet**, comes before the others, and appears by itself when it has. On a computer
short of room, tick **Bring photos only when someone opens them** in Settings, Network: then a
photo comes only once someone opens the firing it belongs to.

Changes to people, roles and collections need the host: an admin makes them only while this
computer can reach it, so two admins cannot change the team in ways that clash.

## Checking a record out

If you are about to change a recipe, material, firing, batch sheet, mix, limit formula or price
list for a while, choose **Check out** on it.
Everyone else then sees that you are changing it, and cannot save it until you choose **Done
changing it**. A checkout ends by itself after eight hours.

If someone left a record checked out, choose **Take it over**. The audit log notes that you did.

Checking out needs the host. Work saved where the host could not be reached is never refused:
if two people changed the same record apart, it becomes a [fork](forks.md), and one of them
chooses which version to keep.

## Away from the network

A computer works the same away from the host: a laptop in the kiln shed, or on a trip. After two
weeks without a sync, unless an admin chose another number, Glaze Vault reminds you to bring it
back to the network, so the team's copies do not drift apart.

An admin can also choose a number of days after which a computer away stops taking changes. The
reminder says how many days are left. After that you can still open, read and print everything,
and what you type is kept as a draft, but nothing is saved until the computer syncs. If you cannot
reach the network, ask an admin for an **extension code**: they read out something like
`14-K7Q-F9M2D-XW3PA`, which you type in the notice. It works only on this computer, and lets it
take changes for the days the admin chose.

The limit is a rule in the app, not a lock. It keeps a team's work together; it does not stop
someone who has the computer and their password from getting round it.

If this computer's clock is put back more than a day, it counts as too long away, until it syncs
or takes a code.

## Leaving

To take a computer out of the vault, as before giving it away, choose **Leave this vault…** in
Settings, Network. Glaze Vault says if anything saved here has not reached the host yet: sync
first if you can, because it would be lost. This computer's copy is then written over and
removed. The host, and the other computers, keep everything that reached the host.

The computer that serves the vault does not leave it: it [stops serving](hosting.md#stopping).

If an admin [retires this computer](hosting.md#retiring-a-computer-or-one-that-was-lost), its copy
is removed the next time it reaches the host, and Glaze Vault says so.
