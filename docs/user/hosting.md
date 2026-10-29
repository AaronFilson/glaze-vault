# Serving the vault on your network

A shared vault can be served from one computer to the team's other computers on the same
network: a studio desktop, say, for the laptops and the computer by the kilns. Each computer
keeps its own copy of what its people can see, and works on it without the network; they sync
when they can reach the host.

The other computers then [join it](joining.md).

## Before you start

- The vault must be [shared](sharing.md), and you must be an admin.
- The computer that serves should stay on, and on the network, while others work. The others
  keep working when it is off, and catch up when it is back.
- On Linux, install Glaze Vault from the `.deb` or `.rpm`: the AppImage cannot serve. Open the
  port (47917 unless you choose another) in your firewall.
- Turn on disk encryption (FileVault on a Mac, BitLocker on Windows, LUKS on Linux). The service
  holds no key to your recipes, but its files name the people and collections in the vault.

## Serving

1. Open **Settings**. Under **Network**, give the name other computers will see, and change the
   port only if 47917 is taken.
2. Choose **Serve on this network**. Your computer asks for an administrator's password, to
   install the service that serves the vault from when the computer starts, even with nobody
   signed in.

You keep working on this computer as before, and everyone in the vault can still sign in here.
It syncs with the service by itself, as the other computers do ([Syncing](joining.md#syncing)).

## Pairing a computer

1. Under **Network**, choose **Pair a computer…**. A code like `4821-0937` appears. It works
   once, for ten minutes.
2. On the other computer, choose **Join a vault on this network**, and type the code
   ([Joining](joining.md)).
3. The other computer's name, and a short key such as `428b-ec49-9b19-3bd5`, appear here. Check
   that the other computer shows the same key.
4. Tick who will use that computer, and choose **Approve**. Only they can sign in there, with
   their own passwords, and it holds only what they can see.

A wrong code ends the pairing: start again for a new one. **Show the computers paired** lists them.

## Computers away from the network

Under **Computers away from the host**, choose after how many days without a sync a computer
reminds its people (14 unless you change it), and, if you want, after how many it stops taking
changes until it syncs. See [Away from the network](joining.md#away-from-the-network).

To let a computer that is away take changes for a while, choose **Show the computers paired**,
then **Extension code…** beside it. Choose the days, and read the code out to whoever is at it.

## Retiring a computer, or one that was lost

Choose **Show the computers paired**, then beside the computer:

- **Retire…** when it is given away or replaced. It stops syncing, and removes its copy of the
  vault the next time it reaches the host.
- **Lost or stolen…** when someone else may have it. It stops syncing too, and every collection it
  could read gets a new key, so what is saved from now on is out of its reach. Each of its people
  gets a new one-time password, shown on screen to pass on: their keys are on the lost computer,
  under their passwords. Anyone whose keys are not on the computer you are at is named: reset them
  from the computer that serves the vault, under **People**, **Reset password…**.

Until a lost computer reaches the host, it still opens with its people's old passwords. What
protects it is those passwords, and that it holds only what they can see.

## The host's backups

The computer that serves the vault backs it up by itself, each day, and keeps the last 14. The
other computers do not need backups of their own: the host has everything that reached it.

The backups are in the service's own folder, which only an administrator can open. To put one
back, as an administrator on that computer, run the `hostd` program installed beside Glaze Vault
(inside the app on a Mac, in its folder on Windows): `hostd backups` lists them, and
`hostd restore <folder>` restores one. The service restarts, and each computer sends again, at
its next sync, what its people saved since. Computers paired after that backup was made pair
again.

## Stopping

**Stop serving on this network…** syncs a last time, removes the service (your computer asks for
an administrator's password again), and makes the vault one on this computer alone. Other
computers keep what they have, but can no longer sync, and anything saved on them that had not
synced does not come here.
