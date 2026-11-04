//! Finding the host on the LAN (plan section 4.4): it advertises `_glazevault._tcp` by mDNS, with
//! the protocol version and a short tag of its organization's signing key, so a computer can
//! tell its own vault's host without learning anything about whose it is.
//!
//! Desktops and Android browse with `mdns-sd`'s own multicast sockets; on Android the app holds a
//! Wi-Fi multicast lock while it is on screen, or many phones drop what comes. iOS allows those
//! sockets only with an entitlement from Apple, so there it asks the system's Bonjour
//! (`dnssd.rs`). Only desktops advertise (docs/adr/0036-photo-pieces-audit-and-phone-discovery.md).

#[cfg(not(target_os = "ios"))]
use crate::Error;
use crate::Result;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use mdns_sd::ServiceInfo;
#[cfg(not(target_os = "ios"))]
use mdns_sd::{ServiceDaemon, ServiceEvent};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::time::Duration;
#[cfg(not(target_os = "ios"))]
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

#[cfg(not(target_os = "ios"))]
fn mdns_error(e: mdns_sd::Error) -> Error {
    Error::Discovery(e.to_string())
}

/// Advertises the host as `name` on `port`, on every address of this machine.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn advertise(name: &str, port: u16, organization_key: &[u8]) -> Result<Advertised> {
    let daemon = ServiceDaemon::new().map_err(mdns_error)?;
    let host_name = format!("{}.local.", name.replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
    let tag = vault_tag(organization_key);
    let (newest, oldest) = (crate::PROTOCOL.to_string(), crate::OLDEST.to_string());
    let properties = [
        ("proto", newest.as_str()),
        ("oldest", oldest.as_str()),
        ("vault", tag.as_str()),
    ];
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

/// A host that answered, as found, if it speaks a protocol version this side does.
pub(super) fn found<'a>(
    name: String,
    addresses: Vec<IpAddr>,
    port: u16,
    txt: impl Fn(&str) -> Option<&'a str>,
) -> Option<Found> {
    let version = |key| txt(key).and_then(|v| v.parse::<u32>().ok());
    let newest = version("proto")?;
    crate::agree(version("oldest").unwrap_or(newest), newest)?;
    Some(Found {
        name,
        addresses,
        port,
        vault: txt("vault").map(str::to_owned),
    })
}

/// The hosts that answer within `wait`. Blocking.
#[cfg(not(target_os = "ios"))]
pub fn browse(wait: Duration) -> Result<Vec<Found>> {
    let daemon = ServiceDaemon::new().map_err(mdns_error)?;
    let events = daemon.browse(SERVICE).map_err(mdns_error)?;
    let deadline = Instant::now() + wait;
    let mut hosts: Vec<Found> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else { break };
        if let ServiceEvent::ServiceResolved(service) = event {
            let name = service
                .fullname
                .strip_suffix(&format!(".{SERVICE}"))
                .unwrap_or(&service.fullname)
                .to_owned();
            let addresses = service.addresses.iter().map(|a| a.to_ip_addr()).collect();
            let txt = |key: &str| service.txt_properties.get_property_val_str(key);
            if let Some(host) = found(name, addresses, service.port, txt) {
                hosts.retain(|f| f.name != host.name);
                hosts.push(host);
            }
        }
    }
    let _ = daemon.shutdown();
    Ok(hosts)
}

/// The hosts that answer within `wait`, by the system's Bonjour. Blocking.
#[cfg(target_os = "ios")]
pub fn browse(wait: Duration) -> Result<Vec<Found>> {
    super::dnssd::browse(wait)
}
