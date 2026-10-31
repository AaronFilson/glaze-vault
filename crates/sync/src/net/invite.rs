//! What a QR code on an admin's "Pair a computer" holds (docs/adr/0029-phones-as-replicas.md):
//! where the host is, its whole key, and the pairing code, as
//! `glazevault:pair?a=192.168.1.20:47917,10.0.0.5:47917&k=<host key, base64url>&c=4821-0937`.
//! A computer that scans it pins the key before pairing, so a wrong host on the same network is
//! refused by TLS, not left to someone comparing fingerprints.

use crate::{Error, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

const PREFIX: &str = "glazevault:pair?";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    /// Addresses with ports, best first.
    pub addresses: Vec<String>,
    pub host_key: Vec<u8>,
    pub code: String,
}

impl Invite {
    pub fn to_uri(&self) -> String {
        format!(
            "{PREFIX}a={}&k={}&c={}",
            self.addresses.join(","),
            URL_SAFE_NO_PAD.encode(&self.host_key),
            self.code
        )
    }

    /// Reads a scanned code; anything else is refused with a reason a person can act on.
    pub fn parse(text: &str) -> Result<Invite> {
        let not_ours = || Error::Pairing("that is not a Glaze Vault pairing code".into());
        let query = text.trim().strip_prefix(PREFIX).ok_or_else(not_ours)?;
        let (mut addresses, mut host_key, mut code) = (None, None, None);
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("a", value)) => {
                    addresses = Some(
                        value
                            .split(',')
                            .filter(|a| !a.is_empty() && a.len() <= 64 && a.is_ascii())
                            .map(str::to_owned)
                            .collect::<Vec<_>>(),
                    )
                }
                Some(("k", value)) => host_key = URL_SAFE_NO_PAD.decode(value).ok(),
                Some(("c", value)) => code = Some(value.to_owned()),
                _ => {}
            }
        }
        let addresses = addresses.filter(|a| !a.is_empty()).ok_or_else(not_ours)?;
        let host_key = host_key.filter(|k| k.len() == 32).ok_or_else(not_ours)?;
        let code = code
            .filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_ascii_digit() || ch == '-'))
            .ok_or_else(not_ours)?;
        Ok(Invite {
            addresses,
            host_key,
            code,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invite_reads_back_as_it_was_written() {
        let invite = Invite {
            addresses: vec!["192.168.1.20:47917".into(), "[fe80::1]:47917".into()],
            host_key: vec![7; 32],
            code: "4821-0937".into(),
        };
        assert_eq!(Invite::parse(&invite.to_uri()).unwrap(), invite);
    }

    #[test]
    fn other_codes_and_damaged_invites_are_refused() {
        assert!(Invite::parse("https://example.com").is_err());
        assert!(Invite::parse("glazevault:pair?a=1.2.3.4:1&c=1234-5678").is_err());
        let short = format!(
            "glazevault:pair?a=1.2.3.4:1&k={}&c=1234-5678",
            URL_SAFE_NO_PAD.encode([1; 16])
        );
        assert!(Invite::parse(&short).is_err());
        let bad_code = format!(
            "glazevault:pair?a=1.2.3.4:1&k={}&c=12;rm",
            URL_SAFE_NO_PAD.encode([1; 32])
        );
        assert!(Invite::parse(&bad_code).is_err());
    }
}
