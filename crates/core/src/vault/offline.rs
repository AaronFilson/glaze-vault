//! Offline limits (plan section 3.12, docs/adr/0024-offline-limits-and-revocation.md): how long a
//! computer that syncs may go without reaching its host before it reminds its people, and, if an
//! admin says so, before it stops taking changes until it syncs or is given an extension code. It
//! is a rule in the app, not a lock (ADR 5): it keeps a team's copies from drifting apart, and
//! someone with the replica and their password could get round it.

use super::events::{self, Body};
use super::{Vault, now_ms};
use crate::access::Role;
use crate::error::{Error, Result};
use hkdf::hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Crockford's base32, which leaves out letters read as digits.
const BASE32: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The vault's rule, kept by the directory: after how many days without a sync a computer
/// reminds its people, and after how many it stops taking changes, if at all. A role can have a
/// stricter one; a person's is the strictest of the rules for the roles they have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePolicy {
    pub nag_days: u32,
    /// None: never.
    pub limit_days: Option<u32>,
    #[serde(default)]
    pub by_role: Vec<RoleLimit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleLimit {
    pub role: Role,
    pub nag_days: u32,
    pub limit_days: Option<u32>,
}

/// The plan's question 10: remind after two weeks, and never stop.
impl Default for OfflinePolicy {
    fn default() -> Self {
        OfflinePolicy {
            nag_days: 14,
            limit_days: None,
            by_role: Vec::new(),
        }
    }
}

impl OfflinePolicy {
    /// The rule for someone with these roles.
    fn for_roles(&self, roles: &[Role]) -> (u32, Option<u32>) {
        let mut rule = (self.nag_days, self.limit_days);
        for limit in self.by_role.iter().filter(|l| roles.contains(&l.role)) {
            rule.0 = rule.0.min(limit.nag_days);
            rule.1 = match (rule.1, limit.limit_days) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
        }
        rule
    }

    pub(crate) fn check(&self) -> Result<()> {
        let days = |n: u32| (1..=365).contains(&n);
        let fine = |nag: u32, limit: Option<u32>| days(nag) && limit.is_none_or(|l| days(l) && l >= nag);
        if fine(self.nag_days, self.limit_days) && self.by_role.iter().all(|l| fine(l.nag_days, l.limit_days)) {
            Ok(())
        } else {
            Err(Error::InvalidSetting(
                "Days run from 1 to 365, and changes stop no sooner than the reminder starts.",
            ))
        }
    }
}

/// How this computer stands against the rule, for the person signed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineStatus {
    /// Whether the rule applies here: only a computer that syncs with a host, not the host's own.
    pub applies: bool,
    /// When this computer last finished a sync, by its own clock.
    pub last_synced: Option<i64>,
    /// Whole days since then.
    pub days: i64,
    pub nag_days: u32,
    pub limit_days: Option<u32>,
    /// Until when an extension code lets it take changes, if one was given.
    pub extended_until: Option<i64>,
    /// Remind, more firmly each day.
    pub nag: bool,
    /// Changes wait until a sync or an extension code.
    pub read_only: bool,
    /// This computer's clock is more than a day behind what it showed before.
    pub clock_back: bool,
}

fn mac(secret: &[u8], device: Uuid, issued: i64, days: u32) -> u64 {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret).expect("HMAC takes any key");
    mac.update(format!("glaze-vault v1 extension device {device} issued {issued} days {days}").as_bytes());
    let bytes = mac.finalize().into_bytes();
    u64::from_be_bytes(bytes[..8].try_into().expect("eight bytes")) >> 14
}

fn base32(mut value: u64, length: usize) -> String {
    let mut text = vec![b'0'; length];
    for at in (0..length).rev() {
        text[at] = BASE32[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(text).expect("ASCII")
}

fn from_base32(text: &str) -> Option<u64> {
    text.chars().try_fold(0u64, |value, c| {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let digit = BASE32.iter().position(|b| *b as char == c)?;
        Some((value << 5) | digit as u64)
    })
}

/// An extension code (plan section 3.12): `14-K7Q-F9M2D-XW3PA`, the days it gives, the day it was
/// issued (days since 1970, in three base32 characters), and a MAC of both under the secret the
/// computer and the host share from pairing, short enough to read over the phone.
pub fn extension_code(secret: &[u8], device: Uuid, issued_day: i64, days: u32) -> String {
    let day = issued_day.rem_euclid(32 * 32 * 32);
    let mac = base32(mac(secret, device, day, days), 10);
    format!("{days:02}-{}-{}-{}", base32(day as u64, 3), &mac[..5], &mac[5..])
}

/// The day a code was issued and the days it gives, if it is this computer's.
fn read_code(secret: &[u8], device: Uuid, code: &str, today: i64) -> Option<(i64, u32)> {
    let text: String = code.chars().filter(char::is_ascii_alphanumeric).collect();
    if text.len() != 15 {
        return None;
    }
    let days: u32 = text[..2].parse().ok()?;
    let day = from_base32(&text[2..5])? as i64;
    let given = from_base32(&text[5..])?;
    if days == 0 || given != mac(secret, device, day, days) {
        return None;
    }
    // The day as three characters wraps every 89 years: the one nearest before today.
    let cycle = 32 * 32 * 32;
    let issued = today - (today - day).rem_euclid(cycle);
    Some((issued, days))
}

/// Where a replica keeps what the rule needs (meta).
const LAST_SYNCED: &str = "offline_last_synced";
const LATEST_SEEN: &str = "offline_latest_seen";
const EXTENDED_UNTIL: &str = "offline_extended_until";
pub(super) const SECRET: &str = "offline_secret";

impl Vault {
    /// Sets the vault's rule, for an admin.
    pub fn set_offline_policy(&mut self, policy: &OfflinePolicy) -> Result<()> {
        policy.check()?;
        events::record(
            &self.conn,
            &self.signer,
            Body::OfflinePolicySet { policy: policy.clone() },
        )?;
        self.load_collections()
    }

    pub fn offline_policy(&self) -> OfflinePolicy {
        self.directory.offline_policy.clone()
    }

    /// How this computer stands against the rule, now.
    pub fn offline_status(&self) -> Result<OfflineStatus> {
        let policy = &self.directory.offline_policy;
        let roles: Vec<Role> = self
            .directory
            .grants
            .iter()
            .filter(|g| g.person == self.user_id)
            .map(|g| g.role)
            .collect();
        let (nag_days, limit_days) = policy.for_roles(&roles);
        let number = |name: &str| -> Result<Option<i64>> { Ok(self.meta(name)?.and_then(|v| v.parse().ok())) };
        let now = now_ms();
        let applies = self.is_replica()
            && !self
                .host_address()?
                .is_some_and(|address| address.starts_with("127.0.0.1:"));
        let last_synced = number(LAST_SYNCED)?;
        let extended_until = number(EXTENDED_UNTIL)?;
        let clock_back = number(LATEST_SEEN)?.is_some_and(|seen| now < seen - DAY_MS);
        let days = last_synced.map_or(0, |at| (now - at).max(0) / DAY_MS);
        let over = |limit: u32| days >= limit as i64 || clock_back;
        let extended = extended_until.is_some_and(|until| now < until) && !clock_back;
        let read_only = applies && limit_days.is_some_and(over) && !extended;
        Ok(OfflineStatus {
            applies,
            last_synced,
            days,
            nag_days,
            limit_days,
            extended_until,
            nag: applies && over(nag_days),
            read_only,
            clock_back: applies && clock_back,
        })
    }

    /// Refuses a change while this computer has gone too long without a sync (`OfflineTooLong`).
    /// Reading, printing and drafts go on.
    pub(super) fn writable(&self) -> Result<()> {
        if self.is_replica() && self.offline_status()?.read_only {
            return Err(Error::OfflineTooLong);
        }
        Ok(())
    }

    /// A sync finished with nothing left to send: the days start again.
    pub fn mark_synced(&mut self) -> Result<()> {
        let now = now_ms();
        self.set_meta(LAST_SYNCED, &now.to_string())?;
        self.note_time()
    }

    /// Keeps the latest time this computer's clock showed, to tell when it is set back.
    pub fn note_time(&mut self) -> Result<()> {
        let now = now_ms();
        let seen: i64 = self.meta(LATEST_SEEN)?.and_then(|v| v.parse().ok()).unwrap_or(0);
        if now > seen {
            self.set_meta(LATEST_SEEN, &now.to_string())?;
        }
        Ok(())
    }

    /// Takes an extension code an admin read out: changes are taken again for the days it gives
    /// from the day it was issued. A code for another computer, or mistyped, is refused.
    pub fn extend(&mut self, code: &str) -> Result<OfflineStatus> {
        let secret = self
            .meta(SECRET)?
            .and_then(|s| hex::decode(s).ok())
            .ok_or(Error::WrongExtensionCode)?;
        let today = now_ms().div_euclid(DAY_MS);
        let (issued, days) = read_code(&secret, self.device()?, code, today).ok_or(Error::WrongExtensionCode)?;
        let until = (issued + days as i64) * DAY_MS;
        if until <= now_ms() {
            return Err(Error::WrongExtensionCode);
        }
        self.set_meta(EXTENDED_UNTIL, &until.to_string())?;
        // A code also settles a clock that was set back.
        self.set_meta(LATEST_SEEN, &now_ms().to_string())?;
        self.offline_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_reads_back_for_its_computer_only() {
        let (secret, device) = (b"shared at pairing".to_vec(), Uuid::new_v4());
        let code = extension_code(&secret, device, 20_390, 14);
        assert_eq!(code.len(), 18);
        assert!(code.starts_with("14-"));
        assert_eq!(read_code(&secret, device, &code, 20_391), Some((20_390, 14)));
        // Typed in lower case, without dashes, with O for 0.
        let typed = code.replace('-', "").to_lowercase().replace('0', "o");
        assert_eq!(read_code(&secret, device, &typed, 20_391), Some((20_390, 14)));
        assert_eq!(read_code(&secret, Uuid::new_v4(), &code, 20_391), None);
        assert_eq!(read_code(b"another", device, &code, 20_391), None);
        let more = code.replacen("14", "30", 1);
        assert_eq!(read_code(&secret, device, &more, 20_391), None);
    }

    #[test]
    fn a_persons_rule_is_the_strictest_of_their_roles() {
        let policy = OfflinePolicy {
            nag_days: 14,
            limit_days: None,
            by_role: vec![
                RoleLimit {
                    role: Role::Tester,
                    nag_days: 7,
                    limit_days: Some(21),
                },
                RoleLimit {
                    role: Role::Chemist,
                    nag_days: 10,
                    limit_days: Some(30),
                },
            ],
        };
        assert_eq!(policy.for_roles(&[Role::Formulator]), (14, None));
        assert_eq!(policy.for_roles(&[Role::Tester, Role::Chemist]), (7, Some(21)));
        assert!(policy.check().is_ok());
        let backwards = OfflinePolicy {
            nag_days: 14,
            limit_days: Some(7),
            by_role: Vec::new(),
        };
        assert!(backwards.check().is_err());
    }
}
