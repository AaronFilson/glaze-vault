//! Pairing's cryptography (plan section 4.3): a code of 8 digits as the SPAKE2 password, and each
//! side's confirmation an HMAC under the SPAKE2 key over a TLS exporter value, so a man in the
//! middle, with a TLS session of his own to each side, fails it even knowing the code.

use crate::{Error, Result};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::time::Duration;

/// How long a code works.
pub const CODE_LIFETIME: Duration = Duration::from_secs(10 * 60);

const HOST: &[u8] = b"glaze-vault host";
const DEVICE: &[u8] = b"glaze-vault device";
/// The label of the TLS exporter value both ends of one session share.
pub(crate) const EXPORTER: &[u8] = b"glaze-vault v1 pairing";

/// A new code, as read out: `4821-0937`.
pub(crate) fn new_code() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the system's random numbers");
    let n = u64::from_le_bytes(bytes) % 100_000_000;
    format!("{:04}-{:04}", n / 10_000, n % 10_000)
}

/// A code as typed, with only its digits.
pub(crate) fn digits(code: &str) -> String {
    code.chars().filter(char::is_ascii_digit).collect()
}

/// The host's side of SPAKE2, and its message.
pub(crate) fn start_host(code: &str) -> (Spake2<Ed25519Group>, Vec<u8>) {
    Spake2::<Ed25519Group>::start_b(
        &Password::new(digits(code)),
        &Identity::new(DEVICE),
        &Identity::new(HOST),
    )
}

/// The new computer's side of SPAKE2, and its message.
pub(crate) fn start_device(code: &str) -> (Spake2<Ed25519Group>, Vec<u8>) {
    Spake2::<Ed25519Group>::start_a(
        &Password::new(digits(code)),
        &Identity::new(DEVICE),
        &Identity::new(HOST),
    )
}

pub(crate) fn finish(spake: Spake2<Ed25519Group>, theirs: &[u8]) -> Result<Vec<u8>> {
    spake
        .finish(theirs)
        .map_err(|_| Error::Pairing("the pairing message was not valid".into()))
}

/// The exporter value, as `export_keying_material([0; 32], EXPORTER, None)` gave it.
pub(crate) fn exported(value: std::result::Result<[u8; 32], rustls::Error>) -> Result<[u8; 32]> {
    value.map_err(|e| Error::Pairing(e.to_string()))
}

fn mac(key: &[u8], exporter: &[u8; 32], host: bool) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(if host {
        b"glaze-vault v1 pairing confirm host"
    } else {
        b"glaze-vault v1 pairing confirm device"
    });
    mac.update(exporter);
    mac
}

/// One side's confirmation: `host` for the host's, else the computer's.
pub(crate) fn confirmation(key: &[u8], exporter: &[u8; 32], host: bool) -> Vec<u8> {
    mac(key, exporter, host).finalize().into_bytes().to_vec()
}

/// Whether `confirmation` is that side's, compared in constant time.
pub(crate) fn confirms(key: &[u8], exporter: &[u8; 32], host: bool, confirmation: &[u8]) -> bool {
    mac(key, exporter, host).verify_slice(confirmation).is_ok()
}

/// The secret a computer and the host share from pairing (plan section 3.12), for extension
/// codes: neither sends it, as both have the SPAKE2 key.
pub(crate) fn offline_secret(key: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(b"glaze-vault v1 offline-secret");
    mac.finalize().into_bytes().to_vec()
}

/// A short form of a key for people to compare: the first 8 bytes of its SHA-256, in groups.
pub fn fingerprint(key: &[u8]) -> String {
    let hash = hex::encode(&Sha256::digest(key)[..8]);
    hash.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).expect("hex"))
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_eight_digits_and_both_sides_agree_only_on_the_same_one() {
        let code = new_code();
        assert_eq!(code.len(), 9);
        assert_eq!(digits(&code).len(), 8);
        let (host, host_msg) = start_host(&code);
        let (device, device_msg) = start_device(&digits(&code));
        assert_eq!(finish(host, &device_msg).unwrap(), finish(device, &host_msg).unwrap());

        let (host, host_msg) = start_host("1111-1111");
        let (device, device_msg) = start_device("1111-1112");
        assert_ne!(finish(host, &device_msg).unwrap(), finish(device, &host_msg).unwrap());
    }

    #[test]
    fn a_confirmation_needs_the_same_key_session_and_side() {
        let (key, exporter) = (b"spake2 key".to_vec(), [7u8; 32]);
        let mac = confirmation(&key, &exporter, false);
        assert!(confirms(&key, &exporter, false, &mac));
        assert!(!confirms(&key, &exporter, true, &mac));
        assert!(!confirms(&key, &[8u8; 32], false, &mac));
        assert!(!confirms(b"other", &exporter, false, &mac));
    }
}
