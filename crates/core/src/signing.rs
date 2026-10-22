//! Signatures (docs/adr/0019-signatures-and-audit-log.md): who saved each revision and attachment,
//! and who made each event, kept so that anyone can check it with public keys alone, as the LAN
//! host will.
//!
//! Each person's Ed25519 signing key, and the organization's, comes from their X25519 secret by
//! HKDF, so the key file holds no new secret. A certificate says a signing key is a person's,
//! signed by the organization, or by the key itself in a one-person vault. What is signed is a
//! fixed line of text built here, never serde output, which could change between versions.

use crate::crypto::{self, KeyPair};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/// A person's signing key, from their X25519 secret.
pub(crate) fn person_key(keys: &KeyPair) -> SigningKey {
    derived(keys, b"glaze-vault v1 signing-key")
}

/// The organization's signing key, from its X25519 secret.
pub(crate) fn organization_key(organization: &KeyPair) -> SigningKey {
    derived(organization, b"glaze-vault v1 organization signing-key")
}

fn derived(keys: &KeyPair, info: &[u8]) -> SigningKey {
    let mut seed = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, &keys.secret)
        .expand(info, seed.as_mut())
        .expect("32 bytes is a valid HKDF length");
    SigningKey::from_bytes(&seed)
}

pub(crate) fn public(key: &SigningKey) -> Vec<u8> {
    key.verifying_key().to_bytes().to_vec()
}

/// Who signs what this session saves: the person signed in, with their key.
pub(crate) struct Signer {
    pub vault: Uuid,
    pub person: Uuid,
    pub key: SigningKey,
}

impl Signer {
    pub fn new(vault: Uuid, person: Uuid, keys: &KeyPair) -> Signer {
        Signer {
            vault,
            person,
            key: person_key(keys),
        }
    }

    pub fn sign(&self, payload: &[u8]) -> Vec<u8> {
        sign(&self.key, payload)
    }
}

pub(crate) fn sign(key: &SigningKey, payload: &[u8]) -> Vec<u8> {
    key.sign(payload).to_bytes().to_vec()
}

/// Whether `signature` is `public`'s over `payload`. Strict, so one signature has one form.
pub(crate) fn verify(public: &[u8], payload: &[u8], signature: &[u8]) -> bool {
    let (Ok(public), Ok(signature)) = (<[u8; 32]>::try_from(public), Signature::from_slice(signature)) else {
        return false;
    };
    VerifyingKey::from_bytes(&public).is_ok_and(|key| key.verify_strict(payload, &signature).is_ok())
}

/// In what capacity someone signed a revision, an attachment or an event: they made it, they
/// vouched for it after it was made without a signature, or they moved it, which encrypts it
/// again. Bound into what is signed, so one cannot pass for another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum As {
    Author,
    Attester,
    Mover,
}

impl As {
    pub fn code(self) -> &'static str {
        match self {
            As::Author => "author",
            As::Attester => "attester",
            As::Mover => "mover",
        }
    }

    pub fn parse(text: &str) -> Option<As> {
        [As::Author, As::Attester, As::Mover]
            .into_iter()
            .find(|role| role.code() == text)
    }
}

fn hex_hash(parts: &[&[u8]]) -> String {
    hex::encode(crypto::sha256(parts))
}

fn or_dash(value: Option<String>) -> String {
    value.unwrap_or_else(|| "-".into())
}

/// What is signed for a revision: where it belongs, who saved it when, and hashes of its content
/// and summary, so a summary-only copy without the content still checks.
pub(crate) struct RevisionFacts<'a> {
    pub vault: &'a Uuid,
    pub id: &'a Uuid,
    pub record: &'a Uuid,
    pub kind: &'a str,
    pub collection: &'a Uuid,
    pub epoch: i64,
    pub number: i64,
    pub parent: Option<&'a Uuid>,
    pub deleted: bool,
    pub supersedes: Option<&'a str>,
    pub author: &'a Uuid,
    pub at: i64,
    /// The hash of its nonce and ciphertext (store::content_hash), which a copy without them
    /// still has.
    pub content_hash: &'a [u8],
    pub summary: Option<(&'a [u8], &'a [u8])>,
}

pub(crate) fn revision_payload(facts: &RevisionFacts, signed_as: As, signer: &Uuid) -> Vec<u8> {
    let f = facts;
    format!(
        "glaze-vault v1 revision-{} vault {} revision {} record {} kind {} collection {} epoch {} number {} \
         parent {} deleted {} supersedes {} author {} at {} content {} summary {} signer {signer}",
        signed_as.code(),
        f.vault,
        f.id,
        f.record,
        f.kind,
        f.collection,
        f.epoch,
        f.number,
        or_dash(f.parent.map(Uuid::to_string)),
        u8::from(f.deleted),
        f.supersedes.unwrap_or("-"),
        f.author,
        f.at,
        hex::encode(f.content_hash),
        or_dash(f.summary.map(|(nonce, summary)| hex_hash(&[nonce, summary]))),
    )
    .into_bytes()
}

/// What is signed for an attachment: where it belongs, what it is, and the hash it already keeps.
pub(crate) struct AttachmentFacts<'a> {
    pub vault: &'a Uuid,
    pub id: &'a Uuid,
    pub record: &'a Uuid,
    pub kind: &'a str,
    pub collection: &'a Uuid,
    pub epoch: i64,
    pub media_type: &'a str,
    pub size: i64,
    pub author: &'a Uuid,
    pub at: i64,
    pub sha256: &'a [u8],
}

pub(crate) fn attachment_payload(facts: &AttachmentFacts, signed_as: As, signer: &Uuid) -> Vec<u8> {
    let f = facts;
    format!(
        "glaze-vault v1 attachment-{} vault {} attachment {} record {} kind {} collection {} epoch {} type {} \
         size {} author {} at {} content {} signer {signer}",
        signed_as.code(),
        f.vault,
        f.id,
        f.record,
        f.kind,
        f.collection,
        f.epoch,
        f.media_type,
        f.size,
        f.author,
        f.at,
        hex::encode(f.sha256),
    )
    .into_bytes()
}

/// What is signed for an event: its type, actor, collection and time, and the hash of its body as
/// it is stored.
#[allow(clippy::too_many_arguments)]
pub(crate) fn event_payload(
    vault: &Uuid,
    id: &Uuid,
    kind: &str,
    actor: Option<&Uuid>,
    collection: Option<&Uuid>,
    at: i64,
    body: &str,
    signed_as: As,
    signer: &Uuid,
) -> Vec<u8> {
    format!(
        "glaze-vault v1 event-{} vault {vault} event {id} type {kind} actor {} collection {} at {at} body {} signer {signer}",
        signed_as.code(),
        or_dash(actor.map(Uuid::to_string)),
        or_dash(collection.map(Uuid::to_string)),
        hex_hash(&[body.as_bytes()]),
    )
    .into_bytes()
}

/// What a certificate's issuer signs: that a signing key and an encryption key are a person's.
pub(crate) fn certificate_payload(
    vault: &Uuid,
    person: &Uuid,
    signing_key: &[u8],
    encryption_key: &[u8],
    issued_at: i64,
) -> Vec<u8> {
    format!(
        "glaze-vault v1 person-certificate vault {vault} person {person} signing {} encryption {} issued {issued_at}",
        hex::encode(signing_key),
        hex::encode(encryption_key)
    )
    .into_bytes()
}

/// What the organization signs to certify a computer: its key, and the people who sign in at it.
pub(crate) fn device_payload(
    vault: &Uuid,
    device: &Uuid,
    name: &str,
    signing_key: &[u8],
    people: &[Uuid],
    issued_at: i64,
) -> Vec<u8> {
    let mut people: Vec<String> = people.iter().map(Uuid::to_string).collect();
    people.sort();
    format!(
        "glaze-vault v1 device-certificate vault {vault} device {device} name {} key {} people {} issued {issued_at}",
        hex_hash(&[name.as_bytes()]),
        hex::encode(signing_key),
        people.join(",")
    )
    .into_bytes()
}

/// What signs a person's key file entry on its way to their computers: who it is, when, and its
/// JSON as signed.
pub(crate) fn entry_payload(vault: &Uuid, person: &Uuid, at: i64, entry: &str) -> Vec<u8> {
    format!(
        "glaze-vault v1 key-entry vault {vault} person {person} at {at} entry {}",
        hex_hash(&[entry.as_bytes()])
    )
    .into_bytes()
}

/// What the organization's signing key signs to be listed as the organization's.
pub(crate) fn organization_key_payload(vault: &Uuid, signing_key: &[u8], encryption_key: &[u8]) -> Vec<u8> {
    format!(
        "glaze-vault v1 organization-key vault {vault} signing {} encryption {}",
        hex::encode(signing_key),
        hex::encode(encryption_key)
    )
    .into_bytes()
}

/// Shows that whoever made a certificate for themselves holds the X25519 secret of the person it
/// names, for an admin to check before the organization signs it too: both sides of a
/// Diffie-Hellman exchange between the person's key and the organization's reach the same secret,
/// and only they can. Signing alone would show only that they hold the signing key, which anyone
/// could make.
pub(crate) fn key_proof(secret: &[u8], their_public: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let secret = StaticSecret::from(<[u8; 32]>::try_from(secret).ok()?);
    let public = PublicKey::from(<[u8; 32]>::try_from(their_public).ok()?);
    let shared = Zeroizing::new(secret.diffie_hellman(&public).to_bytes());
    let mut proof = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.as_ref())
        .expand_multi_info(&[b"glaze-vault v1 key-proof ", payload], &mut proof)
        .ok()?;
    Some(proof.to_vec())
}

/// What an audit entry says, as fixed text, for its hash.
#[allow(clippy::too_many_arguments)]
pub(crate) fn audit_payload(
    vault: &Uuid,
    id: &Uuid,
    at: i64,
    person: Option<&Uuid>,
    action: &str,
    kind: Option<&str>,
    record: Option<&Uuid>,
    collection: Option<&Uuid>,
    detail: Option<&str>,
) -> Vec<u8> {
    format!(
        "glaze-vault v1 audit vault {vault} entry {id} at {at} person {} action {action} kind {} record {} \
         collection {} detail {}",
        or_dash(person.map(Uuid::to_string)),
        kind.unwrap_or("-"),
        or_dash(record.map(Uuid::to_string)),
        or_dash(collection.map(Uuid::to_string)),
        or_dash(detail.map(|d| hex_hash(&[d.as_bytes()]))),
    )
    .into_bytes()
}

/// The hash an audit entry chains on: the one before it, and the entry's own fixed text.
pub(crate) fn audit_hash(previous: &[u8], payload: &[u8]) -> Vec<u8> {
    crypto::sha256(&[previous, payload]).to_vec()
}

/// What signs an audit entry: its place in the chain.
pub(crate) fn audit_signature_payload(vault: &Uuid, hash: &[u8]) -> Vec<u8> {
    format!(
        "glaze-vault v1 audit-signature vault {vault} hash {}",
        hex::encode(hash)
    )
    .into_bytes()
}

/// A signing key's seed, for tests to compare.
#[cfg(test)]
pub(crate) fn seed(key: &SigningKey) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(key.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_keys_come_from_the_x25519_secret_and_differ_by_purpose() {
        let keys = KeyPair::generate();
        let again = KeyPair::from_secret(keys.secret.clone()).unwrap();
        assert_eq!(*seed(&person_key(&keys)), *seed(&person_key(&again)));
        assert_ne!(*seed(&person_key(&keys)), *seed(&organization_key(&keys)));
        let signature = sign(&person_key(&keys), b"payload");
        let public = public(&person_key(&keys));
        assert!(verify(&public, b"payload", &signature));
        assert!(!verify(&public, b"other", &signature));
        assert!(!verify(&public[..31], b"payload", &signature));
    }

    #[test]
    fn both_sides_of_a_key_proof_agree_and_nobody_else_can_make_it() {
        let (person, organization, stranger) = (KeyPair::generate(), KeyPair::generate(), KeyPair::generate());
        // The same X25519 keys as HPKE's.
        assert_eq!(
            PublicKey::from(&StaticSecret::from(<[u8; 32]>::try_from(&person.secret[..]).unwrap()))
                .as_bytes()
                .to_vec(),
            person.public
        );
        let made = key_proof(&person.secret, &organization.public, b"certificate").unwrap();
        assert_eq!(
            key_proof(&organization.secret, &person.public, b"certificate").unwrap(),
            made
        );
        assert_ne!(
            key_proof(&stranger.secret, &organization.public, b"certificate").unwrap(),
            made
        );
        assert_ne!(
            key_proof(&organization.secret, &person.public, b"another").unwrap(),
            made
        );
    }
}
