//! What a LAN host and its replicas send each other (docs/adr/0020-sync-core.md): the items of
//! the change log, as they are stored and signed, the scopes and cursors they are pulled by, and
//! what a computer needs to join. The host (host.rs) checks and orders what replicas push; each
//! replica (vault/replica.rs) applies what it pulls. Nothing here does IO: `crates/sync` frames
//! these as messages and sends them.

use crate::crypto::Sealed;
use crate::keyring::PersonEntry;
use crate::vault::Kind;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

/// A part of the change log a computer pulls by its own cursor: the directory (people, roles,
/// grants), or one collection's records and events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Directory,
    Collection(Uuid),
}

impl Scope {
    /// The change log's `collection_id` for the scope.
    pub(crate) fn column(self) -> Option<String> {
        match self {
            Scope::Directory => None,
            Scope::Collection(id) => Some(id.to_string()),
        }
    }

    /// How sync_state keys it.
    pub(crate) fn key(self) -> String {
        self.column().unwrap_or_default()
    }

    pub(crate) fn from_key(key: &str) -> Option<Scope> {
        if key.is_empty() {
            Some(Scope::Directory)
        } else {
            Uuid::parse_str(key).ok().map(Scope::Collection)
        }
    }
}

/// Which of a collection's keys a computer's people hold between them, and so which of its items
/// it is sent: all of them, batch sheets and mixes, or recipes' summaries and firings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Collection,
    Batch,
    Summary,
}

impl Level {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Level::Collection => "collection",
            Level::Batch => "batch",
            Level::Summary => "summary",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Level> {
        [Level::Collection, Level::Batch, Level::Summary]
            .into_iter()
            .find(|level| level.code() == text)
    }
}

/// A signature over an item as the wire carries it (signing.rs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSignature {
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
    pub signer: Uuid,
    /// "author", "attester" or "mover".
    pub signed_as: String,
}

/// A revision as it is stored. For a computer that reads only a recipe's summary its nonce and
/// ciphertext are empty: `content_hash`, which its signature covers, stands for them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionItem {
    pub id: Uuid,
    pub record: Uuid,
    pub kind: Kind,
    pub collection: Uuid,
    pub parent: Option<Uuid>,
    pub number: i64,
    pub deleted: bool,
    pub supersedes: Option<String>,
    pub epoch: i64,
    pub author: Uuid,
    pub created_at: i64,
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub content_hash: Vec<u8>,
    pub summary: Option<SummaryItem>,
    pub signed: ItemSignature,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryItem {
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub summary: Vec<u8>,
}

/// An attachment as it is stored, its bytes with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentItem {
    pub id: Uuid,
    pub record: Uuid,
    pub kind: Kind,
    pub collection: Uuid,
    pub media_type: String,
    pub size: i64,
    pub author: Uuid,
    pub created_at: i64,
    pub epoch: i64,
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub sha256: Vec<u8>,
    pub signed: ItemSignature,
}

/// An event (ADR 18), its body as it was made.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventItem {
    pub id: Uuid,
    pub actor: Option<Uuid>,
    pub at: i64,
    pub body: String,
    pub signed: ItemSignature,
}

/// The latest of a person's key file entries, which reaches their computers and replaces the one
/// before: never logged for good, unlike an event, since each holds their private key under a
/// password they had.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryItem {
    pub person: Uuid,
    /// The entry as JSON, as it was signed.
    pub entry: String,
    pub at: i64,
    pub signer: Uuid,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

impl EntryItem {
    pub(crate) fn parsed(&self) -> Option<PersonEntry> {
        serde_json::from_str(&self.entry).ok()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "item", rename_all = "camelCase")]
pub enum Item {
    Revision(RevisionItem),
    Attachment(AttachmentItem),
    Event(EventItem),
    Entry(EntryItem),
}

impl Item {
    /// What a push result names it by: an entry by its person.
    pub fn id(&self) -> Uuid {
        match self {
            Item::Revision(r) => r.id,
            Item::Attachment(a) => a.id,
            Item::Event(e) => e.id,
            Item::Entry(e) => e.person,
        }
    }

    /// About how many bytes it takes, to keep a batch to a size.
    pub fn size(&self) -> usize {
        match self {
            Item::Revision(r) => 400 + r.ciphertext.len() + r.summary.as_ref().map_or(0, |s| s.summary.len()),
            Item::Attachment(a) => 400 + a.ciphertext.len(),
            Item::Event(e) => 300 + e.body.len(),
            Item::Entry(e) => 300 + e.entry.len(),
        }
    }
}

/// An item pulled, with the scope and the host's number it came at.
#[derive(Clone, Serialize, Deserialize)]
pub struct Pulled {
    pub scope: Scope,
    pub seq: i64,
    pub item: Item,
}

/// The host's answer to a computer saying hello: which scopes to start again from nothing, since
/// what its people hold there changed, and which to drop, since they hold nothing there now.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub revoked: bool,
    pub reset: Vec<Scope>,
    pub dropped: Vec<Scope>,
    /// What the computer's people hold now in each collection, to say next time.
    pub levels: Vec<(Scope, Vec<Level>)>,
}

/// Items in order, the cursors after them, and whether there are more.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Batch {
    pub items: Vec<Pulled>,
    pub cursors: Vec<(Scope, i64)>,
    pub more: bool,
}

/// Why the host would not take an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "refusal", rename_all = "camelCase")]
pub enum Refusal {
    NotAllowed,
    BadSignature,
    /// Its signer's key is not certified, or no longer.
    UnknownSigner,
    /// The collection has a newer key: seal it again under that one.
    StaleEpoch {
        current: i64,
    },
    /// Its record was erased.
    Erased,
    /// An erasure of a record someone changed since it was deleted.
    ChangedElsewhere,
    ParentUnknown,
    /// Something about it does not hold together.
    Invalid {
        reason: String,
    },
}

impl Refusal {
    pub(crate) fn code(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// What the host took, with the number it gave each, and what it would not, and why.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PushResult {
    pub accepted: Vec<(Uuid, i64)>,
    pub refused: Vec<(Uuid, Refusal)>,
}

/// The organization's statement that a computer, its signing key, may sync, for these people.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCertificate {
    pub device: Uuid,
    pub name: String,
    #[serde(with = "serde_bytes")]
    pub signing_key: Vec<u8>,
    pub people: Vec<Uuid>,
    pub issued_at: i64,
    #[serde(with = "serde_bytes")]
    pub issuer_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

/// A computer the host syncs with, as an admin sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: Uuid,
    pub name: String,
    pub people: Vec<Uuid>,
    pub issued_at: i64,
    pub revoked: bool,
}

/// The organization part of the key file that every computer keeps: its public key, and its
/// private key under its recovery key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationEntry {
    #[serde(with = "crate::crypto::b64")]
    pub public_key: Vec<u8>,
    pub private_key_by_recovery: Sealed,
}

/// What a computer needs to become a replica: the vault, its certificate, and the key file
/// entries of the people who will sign in at it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinPackage {
    pub vault: Uuid,
    pub default_collection: Uuid,
    pub device: DeviceCertificate,
    pub organization: OrganizationEntry,
    /// Each person's key file entry, as signed.
    pub entries: Vec<EntryItem>,
    /// The host's Ed25519 key, which the computer pins.
    #[serde(default, with = "serde_bytes")]
    pub host_key: Vec<u8>,
}

/// A computer's own signing key, made when it joins, and kept in its replica.
pub struct DeviceKey {
    pub id: Uuid,
    pub(crate) seed: Zeroizing<[u8; 32]>,
}

impl DeviceKey {
    pub fn generate() -> DeviceKey {
        DeviceKey {
            id: Uuid::new_v4(),
            seed: Zeroizing::new(crate::crypto::random()),
        }
    }

    /// The key's seed, for the computer's TLS identity.
    pub fn seed(&self) -> &Zeroizing<[u8; 32]> {
        &self.seed
    }

    pub fn public(&self) -> Vec<u8> {
        crate::signing::public(&ed25519_dalek::SigningKey::from_bytes(&self.seed))
    }
}
