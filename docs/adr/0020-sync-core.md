# 20. The sync core: a blind host, replicas, and what they send each other

Proposed, 2026-10-21. Changes how [ADR 19](0019-signatures-and-audit-log.md) decides a
certificate is trusted: by order in the change log, not by time. Stage 4 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery),
its section 3, with no network yet: the host's store, replicas, the messages between them and
the two sides of a sync, tested in one process. Replaces [ADR 5](0005-lan-host-and-replicas.md)'s
"batch logs, firing logs and notes are events": firings and mixes are records with revisions, and
events are the directory's, erasures and moves ([ADR 18](0018-directory-events.md)).

## Context

Stages 1 to 3 made every revision, attachment and event something that is only ever added,
signed, and listed in a change log in the order a store got it ([ADR 17](0017-key-epochs-change-log.md),
[ADR 18](0018-directory-events.md), [ADR 19](0019-signatures-and-audit-log.md)). What was left was
the host that numbers them, decides who gets what without any collection key, and checks what it
is sent; and replicas that apply what they get and send what was saved on them.

## Decision

- **One schema, three modes.** A store's `meta` says `host` or `replica`; a vault on one computer
  says neither. Schema 11 adds the computers a host syncs with (`devices`), each person's latest
  key file entry (`key_entries`), a replica's cursors (`sync_state`) and what the host refused it
  (`refused`), and each revision's `content_hash`.
- **Making a host** (`Vault::prepare_host`, for an admin): the vault must be changed over to
  summaries, with no change of organization key half done, and everything signed (the admin
  vouches for what is not, first). The database is copied, encrypted again under a key of the
  host's own, sealed to an X25519 key from `host.key` (`host.json`), and loses what belongs to one
  computer: drafts, settings, the last backup. Every change already logged gets the host's number.
  Installing it as a service, and the admin's way into it, are stage 6.
- **Computers.** An admin certifies a computer's own Ed25519 key and the people who sign in at it,
  with the organization's signing key (`certify_device`); the host takes a certificate from its
  current organization key only. What a computer needs to join is that certificate, the
  organization's public key and its private key under its recovery key, and its people's key file
  entries (`JoinPackage`). The replica makes its own database key and seals it to them. Its people
  sign in with the passwords they have. Pairing, which carries this, is stage 5.
- **Key file entries** are not events (ADR 18): the host keeps the latest of each, signed by the
  person or an admin, with the same public key the directory has, and sends it only to that
  person's computers. A replica that sees its key file differ from what it last sent or got pushes
  the entry: a new password set on one laptop reaches the person's others.
- **What a computer gets.** Its scopes are the directory and each collection its people hold any
  key of; an admin's holds all of them. Per collection the host works out the keys its people hold
  between them: the collection's key, the batch key, the summary key, or both of the narrower
  ones. It sends every revision and attachment for the collection's key; batch sheets and mixes for
  the batch key; firings, with their photos, for the summary key, and recipes' revisions without
  their nonce and ciphertext, whose `content_hash` stands for them in the signature. Every event in
  a collection's scope goes to whoever reads the collection at all. In the directory, others'
  grants go only to admins and to whoever manages that collection, and the collections' keys
  sealed to the organization only to admins; key file entries only to their people.
- **A collection's making and its name** are in the collection's scope, not the directory's, so
  only those who read it learn its name, and whoever comes to read it gets them as they catch up.
  A grant can arrive before them: a replica stands in a collection with no name until they come,
  and keeps a collection whose newest key has not all arrived closed until it has.
- **Cursors and levels.** A replica keeps a cursor per scope and what it was told its people hold
  in each, and says them in its hello. The host keeps nothing of either: a collection whose keys
  held have changed is pulled again from the start, after the replica forgets what it had of it;
  one its people no longer read is dropped the same way.
- **What the host checks.** A revision or attachment: its content is what was signed; signed by a
  certified key not revoked, of one of the computer's people; by its author, or by whoever moved it
  there; who may change that kind of record in the collection; under the collection's current key
  (else `StaleEpoch`); of a record not erased; after a revision of the same record, in the same
  collection, numbered next. An event: signed by its actor, one of the computer's people; allowed
  by the same directory check as on one computer; and an erasure only if every newest revision of
  its record deletes it (else `ChangedElsewhere`). Events that come one after another were made
  together and are taken all or none. An item the host has already is taken again, with its
  number, so a push whose answer was lost can be sent again.
- **What a replica does.** It checks each signature again as it applies what it pulls; one that
  does not match stops the sync. Items it pushed itself come back with the host's numbers. What it
  has to push is whatever it logged that has no host number and was not refused, in order. Before
  pushing, it seals again under the newest key what its person saved under an older one. Refused:
  for an erased record, its item goes; an erasure of a record changed elsewhere is undone and the
  collection pulled again; anything else is set aside, kept, and shown.
- **Erasing on a replica** waits until the delete has reached the host (`NotSynced`), which checks
  it. A replica that pulls an erasure drops the record, with anything of it it had not sent.
- **Moves** (ADR 18): the move event removes the record's rows still in the collection it left,
  wherever it is applied; the rows encrypted for where it went follow it, signed by the mover. A
  replica that cannot read where it went keeps nothing of it.
- **Trust goes by order, not by clocks.** ADR 19 trusted a certificate issued while its issuer was
  the organization's key, by the times each gave. Computers' clocks differ: an admin's laptop whose
  clock is behind would issue certificates that seemed older than the organization key, and were
  never trusted. Now each certificate and organization key keeps where it came in its store's
  change log (`place`), and a key's window runs from its place to the place of the key or the
  return to one person that retired it. A replica applies the directory in the host's order, so
  every store agrees. Vaults from before get their places from the events that made them.
- **The protocol** (crates/sync): `Hello`, `Pull`, `Push`, `Bye` from the computer; `Welcome`,
  `Batch`, `PushResult`, `Refused` from the host; each a 4-byte length and CBOR (`ciborium`), at
  most 32 MiB, version 1. Bytes travel as bytes. A photo goes whole inside its item for now. The
  two sides are state machines that take a message and give the next, with no IO; one sync is
  hello, pull until there is no more, push until nothing is left or nothing is taken.
- **Tests** run a host and computers in one process, every message through a frame and back, and
  a seeded random run of saves, deletes, syncs and new keys on three computers that must end
  showing the same. `crates/core`'s `test-kdf` feature makes Argon2id cheap for those tests; CI
  fails if the app is built with it.

## Consequences

- The model is proven before any socket: stages 5 and 6 add the transport, pairing and the
  service around it.
- Directory changes made on a replica go to the host at its next sync. If the host refuses one,
  because another admin changed something meanwhile, the replica has applied it already and stays
  apart until stage 7 makes such changes wait for the host (the plan's question 5).
- An admin's computer holds only its own people's key file entries, so resetting, making an admin
  of, or taking admin from someone else, is for the host computer's app (stage 6). A new
  organization recovery sheet, or a change of organization key, does not reach other computers'
  key files yet.
- The audit log stays on each computer; the host keeping and signing it comes later. Checking
  out records, revoking computers, offline limits and restoring the host are stages 7 and 8.
- A replica drops what it held of a collection whose keys held changed, and pulls it again.
- Older versions of the app refuse a vault at schema 11.
