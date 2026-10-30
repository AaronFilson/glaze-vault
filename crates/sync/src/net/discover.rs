//! Finding the host on the LAN (plan section 4.4): it advertises `_glazevault._tcp` by mDNS, with
//! the protocol version and a short tag of its organization's signing key, so a computer can
//! tell its own vault's host without learning anything about whose it is.
//!
//! Desktops only. On phones and tablets `mdns-sd`'s own multicast sockets would need an
//! entitlement from Apple, so they find no hosts here and are paired by address (ADR 26).

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::Error;
use crate::Result;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::time::Duration;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::time::Instant;

pub const SERVICE: &str = "_glazevault._tcp.local.";

/// The TXT record's `vault=`: the first 8 bytes of SHA-256 of the organization's signing key.
pub fn vault_tag(organization_key: &[u8]) -> String {
    hex::encode(&Sha256::digest(organization_key)[..8])
}

/// A host being advertised, until this is dropped.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub struct Advertised(ServiceDaemon);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl Drop for Advertised {
    fn drop(&mut self) {
        let _ = self.0.shutdown();
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn mdns_error(e: mdns_sd::Error) -> Error {
    Error::Discovery(e.to_string())
}

/// Advertises the host as `name` on `port`, on every address of this machine.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn advertise(name: &str, port: u16, organization_key: &[u8]) -> Result<Advertised> {
    let daemon = ServiceDaemon::new().map_err(mdns_error)?;
    let host_name = format!("{}.local.", name.replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
    let tag = vault_tag(organization_key);
    let properties = [("proto", "1"), ("vault", tag.as_str())];
    let info = ServiceInfo::new(SERVICE, name, &host_name, "", port, &properties[..])
        .map_err(mdns_error)?
        .enable_addr_auto();
    daemon.register(info).map_err(mdns_error)?;
    Ok(Advertised(daemon))
}

/// A host found on the LAN.
#[derive(Debug, Clone)]
pub struct Found {
    pub name: String,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
    pub vault: Option<String>,
}

/// The hosts that answer within `wait`. Blocking.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn browse(wait: Duration) -> Result<Vec<Found>> {
    let daemon = ServiceDaemon::new().map_err(mdns_error)?;
    let events = daemon.browse(SERVICE).map_err(mdns_error)?;
    let deadline = Instant::now() + wait;
    let mut found: Vec<Found> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else { break };
        if let ServiceEvent::ServiceResolved(service) = event {
            if service.txt_properties.get_property_val_str("proto") != Some("1") {
                continue;
            }
            let name = service
                .fullname
                .strip_suffix(&format!(".{SERVICE}"))
                .unwrap_or(&service.fullname)
                .to_owned();
            found.retain(|f| f.name != name);
            found.push(Found {
                name,
                addresses: service.addresses.iter().map(|a| a.to_ip_addr()).collect(),
                port: service.port,
                vault: service.txt_properties.get_property_val_str("vault").map(str::to_owned),
            });
        }
    }
    let _ = daemon.shutdown();
    Ok(found)
}

/// Phones and tablets find no hosts by mDNS (see the top of this file).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn browse(_wait: Duration) -> Result<Vec<Found>> {
    Ok(Vec::new())
}
