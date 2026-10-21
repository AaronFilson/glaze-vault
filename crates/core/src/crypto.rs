//! The few primitives the vault is built from (docs/adr/0003-encryption-and-keys.md):
//! XChaCha20-Poly1305 for anything under a symmetric key, Argon2id for passwords, HKDF-SHA256 for
//! recovery keys, and HPKE (RFC 9180, X25519, HKDF-SHA256, ChaCha20-Poly1305) to seal keys to a
//! user's public key. Every ciphertext is bound to what it is with associated data.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use hpke::{Deserializable, Kem as _, OpModeR, OpModeS, Serializable};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

type Kem = hpke::kem::X25519HkdfSha256;
type Kdf = hpke::kdf::HkdfSha256;
type HpkeAead = hpke::aead::ChaCha20Poly1305;

/// A 256-bit symmetric key that is wiped when dropped.
pub type Key = Zeroizing<[u8; 32]>;

pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the operating system's random number generator failed");
    bytes
}

pub fn random_key() -> Key {
    Zeroizing::new(random())
}

/// Something encrypted under a symmetric key, with its nonce.
#[derive(Clone, Serialize, Deserialize)]
pub struct Sealed {
    #[serde(with = "b64")]
    pub nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
}

pub fn encrypt(key: &Key, plaintext: &[u8], aad: &[u8]) -> Sealed {
    let nonce: [u8; 24] = random();
    let ciphertext = XChaCha20Poly1305::new(&(**key).into())
        .encrypt(&XNonce::from(nonce), Payload { msg: plaintext, aad })
        .expect("encryption with a valid key cannot fail");
    Sealed {
        nonce: nonce.to_vec(),
        ciphertext,
    }
}

/// None when the key is wrong, or the ciphertext or its associated data were changed.
pub fn decrypt(key: &Key, sealed: &Sealed, aad: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let nonce: [u8; 24] = sealed.nonce.as_slice().try_into().ok()?;
    XChaCha20Poly1305::new(&(**key).into())
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &sealed.ciphertext,
                aad,
            },
        )
        .ok()
        .map(Zeroizing::new)
}

/// Argon2id settings, stored beside what they protect so they can be raised later.
#[derive(Clone, Serialize, Deserialize)]
pub struct PasswordKdf {
    pub memory_kib: u32,
    pub passes: u32,
    pub lanes: u32,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
}

/// Memory and passes for new passwords. Tests make many vaults, each hashing several passwords,
/// so they use the least Argon2id allows; unlocking uses whatever is stored, so nothing else differs.
#[cfg(not(test))]
const NEW_KDF: (u32, u32) = (64 * 1024, 3);
#[cfg(test)]
const NEW_KDF: (u32, u32) = (8, 1);

impl PasswordKdf {
    pub fn new() -> Self {
        PasswordKdf {
            memory_kib: NEW_KDF.0,
            passes: NEW_KDF.1,
            lanes: 1,
            salt: random::<16>().to_vec(),
        }
    }

    pub fn derive(&self, password: &str) -> Key {
        let params = Params::new(self.memory_kib, self.passes, self.lanes, Some(32))
            .expect("stored Argon2 parameters are valid");
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &self.salt, key.as_mut())
            .expect("Argon2 output length is valid");
        key
    }
}

/// A recovery key is already 256 random bits, so HKDF (not a slow password hash) turns it into
/// the key that encrypts the user's private key.
pub fn recovery_key(entropy: &[u8], salt: &[u8]) -> Key {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), entropy)
        .expand(b"glaze-vault v1 recovery", key.as_mut())
        .expect("32 bytes is a valid HKDF length");
    key
}

/// The key a backup's contents are encrypted under, from the database key and a salt of the
/// backup's own, so each backup has a different key.
pub fn backup_key(database_key: &Key, salt: &[u8], info: &[u8]) -> Key {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), database_key.as_ref())
        .expand(info, key.as_mut())
        .expect("32 bytes is a valid HKDF length");
    key
}

/// A key for one use, from a key that opens more: whoever holds `key` can make it, but it does not
/// lead back to `key`.
pub fn narrower_key(key: &Key, info: &[u8]) -> Key {
    let mut narrower = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, key.as_ref())
        .expand(info, narrower.as_mut())
        .expect("32 bytes is a valid HKDF length");
    narrower
}

/// SHA-256 of the parts, one after another.
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

impl Sealed {
    /// The nonce and then the ciphertext, for a BLOB column.
    pub fn to_bytes(&self) -> Vec<u8> {
        [self.nonce.as_slice(), &self.ciphertext].concat()
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Sealed> {
        (bytes.len() > 24).then(|| Sealed {
            nonce: bytes[..24].to_vec(),
            ciphertext: bytes[24..].to_vec(),
        })
    }
}

/// A user's X25519 key pair. Keys are sealed to the public key; the private key never leaves
/// memory unencrypted.
pub struct KeyPair {
    pub secret: Zeroizing<Vec<u8>>,
    pub public: Vec<u8>,
}

impl KeyPair {
    pub fn generate() -> Self {
        let (secret, public) = Kem::gen_keypair();
        KeyPair {
            secret: Zeroizing::new(secret.to_bytes().to_vec()),
            public: public.to_bytes().to_vec(),
        }
    }

    /// Rebuilds a key pair from its private key, so a public key cannot be swapped under it.
    pub fn from_secret(secret: Zeroizing<Vec<u8>>) -> Option<Self> {
        let private = <Kem as hpke::Kem>::PrivateKey::from_bytes(&secret).ok()?;
        let public = Kem::sk_to_pk(&private).to_bytes().to_vec();
        Some(KeyPair { secret, public })
    }
}

/// A key sealed to someone's public key with HPKE.
#[derive(Clone, Serialize, Deserialize)]
pub struct SealedBox {
    #[serde(with = "b64")]
    pub enc: Vec<u8>,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
}

pub fn seal_key(recipient: &[u8], key: &Key, info: &[u8]) -> SealedBox {
    let public =
        <Kem as hpke::Kem>::PublicKey::from_bytes(recipient).expect("public keys are checked when they are read");
    let (enc, ciphertext) =
        hpke::single_shot_seal::<HpkeAead, Kdf, Kem>(&OpModeS::Base, &public, info, key.as_ref(), &[])
            .expect("sealing to a valid public key cannot fail");
    SealedBox {
        enc: enc.to_bytes().to_vec(),
        ciphertext,
    }
}

pub fn open_key(pair: &KeyPair, sealed: &SealedBox, info: &[u8]) -> Option<Key> {
    let private = <Kem as hpke::Kem>::PrivateKey::from_bytes(&pair.secret).ok()?;
    let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&sealed.enc).ok()?;
    let plain = Zeroizing::new(
        hpke::single_shot_open::<HpkeAead, Kdf, Kem>(&OpModeR::Base, &private, &enc, info, &sealed.ciphertext, &[])
            .ok()?,
    );
    let key: [u8; 32] = plain.as_slice().try_into().ok()?;
    Some(Zeroizing::new(key))
}

/// Base64 for byte fields in JSON.
pub(crate) mod b64 {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        STANDARD.decode(String::deserialize(d)?).map_err(D::Error::custom)
    }
}

/// Base64 for byte fields in JSON that may be left out.
pub(crate) mod b64_option {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => s.serialize_str(&STANDARD.encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|text| STANDARD.decode(text).map_err(D::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symmetric_round_trip_and_tamper() {
        let key = random_key();
        let mut sealed = encrypt(&key, b"Leach 4321", b"context");
        assert_eq!(decrypt(&key, &sealed, b"context").unwrap().as_slice(), b"Leach 4321");
        assert!(decrypt(&key, &sealed, b"other context").is_none());
        assert!(decrypt(&random_key(), &sealed, b"context").is_none());
        sealed.ciphertext[0] ^= 1;
        assert!(decrypt(&key, &sealed, b"context").is_none());
    }

    #[test]
    fn sealed_keys_open_only_for_their_recipient_and_info() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();
        let key = random_key();
        let sealed = seal_key(&alice.public, &key, b"collection 1");
        assert_eq!(*open_key(&alice, &sealed, b"collection 1").unwrap(), *key);
        assert!(open_key(&bob, &sealed, b"collection 1").is_none());
        assert!(open_key(&alice, &sealed, b"collection 2").is_none());
    }

    #[test]
    fn key_pair_rebuilds_its_public_key() {
        let pair = KeyPair::generate();
        let again = KeyPair::from_secret(pair.secret.clone()).unwrap();
        assert_eq!(pair.public, again.public);
    }

    #[test]
    fn password_derivation_depends_on_password_and_salt() {
        let kdf = PasswordKdf {
            memory_kib: 8 * 1024,
            passes: 1,
            lanes: 1,
            salt: vec![7; 16],
        };
        assert_eq!(*kdf.derive("bone ash"), *kdf.derive("bone ash"));
        assert_ne!(*kdf.derive("bone ash"), *kdf.derive("bone ash!"));
        let other = PasswordKdf {
            salt: vec![8; 16],
            ..kdf.clone()
        };
        assert_ne!(*kdf.derive("bone ash"), *other.derive("bone ash"));
    }
}
