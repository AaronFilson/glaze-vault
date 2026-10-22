# Serving the vault on your network

A shared vault can be served from one computer to the team's other computers on the same
network: a studio desktop, say, for the laptops and the computer by the kilns. Each computer
keeps its own copy of what its people can see, and works on it without the network; they sync
when they can reach the host.

> Joining from the other computers comes in the next version of Glaze Vault. For now, this sets
> up the computer that serves.

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
It syncs with the service every half minute, or when you choose **Sync now**.

## Pairing a computer

1. Under **Network**, choose **Pair a computer…**. A code like `4821-0937` appears. It works
   once, for ten minutes.
2. On the other computer, type the code where it asks to join a vault on this network.
3. The other computer's name, and a short key such as `428b-ec49-9b19-3bd5`, appear here. Check
   that the other computer shows the same key.
4. Tick who will use that computer, and choose **Approve**. Only they can sign in there, with
   their own passwords, and it holds only what they can see.

A wrong code ends the pairing: start again for a new one. **Show the computers paired** lists them.

## Stopping

**Stop serving on this network…** syncs a last time, removes the service (your computer asks for
an administrator's password again), and makes the vault one on this computer alone. Other
computers keep what they have, but can no longer sync, and anything saved on them that had not
synced does not come here.
