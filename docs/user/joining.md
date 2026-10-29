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

## Syncing

While you are signed in, Glaze Vault syncs with the host by itself: a few seconds after you save
something, as soon as someone saves on another computer, and every half minute anyway. You never
need to wait for it; you go on working while it syncs.

The bar at the top says how it stands, such as **Synced 10:32**, or **Not synced** when the host
is out of reach. Choose it for more, and for **Sync now**. While the host is out of reach,
everything works as before; what you save is kept, and sent when the host is back.

Photos come after the records they belong to, a piece at a time. One that has not come yet shows
**Photo not synced yet**, and appears by itself when it has.

Changes to people, roles and collections need the host: an admin makes them only while this
computer can reach it, so two admins cannot change the team in ways that clash.

## Checking a record out

If you are about to change a recipe, material or firing for a while, choose **Check out** on it.
Everyone else then sees that you are changing it, and cannot save it until you choose **Done
changing it**. A checkout ends by itself after eight hours.

If someone left a record checked out, choose **Take it over**. The audit log notes that you did.

Checking out needs the host. Work saved where the host could not be reached is never refused:
if two people changed the same record apart, it becomes a [fork](forks.md), and one of them
chooses which version to keep.

## Leaving

To take a computer out of the vault, as before giving it away, choose **Leave this vault…** in
Settings, Network. Glaze Vault says if anything saved here has not reached the host yet: sync
first if you can, because it would be lost. This computer's copy is then written over and
removed. The host, and the other computers, keep everything that reached the host.

The computer that serves the vault does not leave it: it [stops serving](hosting.md#stopping).
