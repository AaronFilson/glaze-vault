//! Finding the host on iOS (docs/adr/0036-photo-pieces-audit-and-phone-discovery.md): the
//! system's own Bonjour, through `dns_sd.h` in libSystem, rather than `mdns-sd`'s multicast
//! sockets, which iOS allows only with an entitlement Apple grants on request. Browsing a service
//! the app's `NSBonjourServices` names needs only that key and the local network permission.
//!
//! Built on macOS too, for its tests, which find a host `mdns-sd` advertises.

// The callbacks take what `dns_sd.h` gives them.
#![allow(clippy::too_many_arguments)]

use super::discover::{Found, found};
use crate::{Error, Result};
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};

type ServiceRef = *mut c_void;
type ErrorType = i32;

const FLAGS_ADD: u32 = 0x2;
const PROTOCOL_IPV4: u32 = 0x1;
const PROTOCOL_IPV6: u32 = 0x2;
const AF_INET: u8 = 2;
const AF_INET6: u8 = 30;
const POLLIN: i16 = 0x1;

type BrowseReply =
    extern "C" fn(ServiceRef, u32, u32, ErrorType, *const c_char, *const c_char, *const c_char, *mut c_void);
type ResolveReply =
    extern "C" fn(ServiceRef, u32, u32, ErrorType, *const c_char, *const c_char, u16, u16, *const u8, *mut c_void);
type AddrReply = extern "C" fn(ServiceRef, u32, u32, ErrorType, *const c_char, *const u8, u32, *mut c_void);

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: i16,
    revents: i16,
}

unsafe extern "C" {
    fn DNSServiceBrowse(
        service: *mut ServiceRef,
        flags: u32,
        interface: u32,
        regtype: *const c_char,
        domain: *const c_char,
        reply: BrowseReply,
        context: *mut c_void,
    ) -> ErrorType;
    fn DNSServiceResolve(
        service: *mut ServiceRef,
        flags: u32,
        interface: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        reply: ResolveReply,
        context: *mut c_void,
    ) -> ErrorType;
    fn DNSServiceGetAddrInfo(
        service: *mut ServiceRef,
        flags: u32,
        interface: u32,
        protocol: u32,
        hostname: *const c_char,
        reply: AddrReply,
        context: *mut c_void,
    ) -> ErrorType;
    fn DNSServiceRefSockFD(service: ServiceRef) -> c_int;
    fn DNSServiceProcessResult(service: ServiceRef) -> ErrorType;
    fn DNSServiceRefDeallocate(service: ServiceRef);
    fn poll(fds: *mut PollFd, count: u32, timeout: c_int) -> c_int;
}

/// A service resolved: its full name, then the host's name, its port, its TXT record's keys and
/// the interface it was heard on.
type Resolved = (String, CString, u16, HashMap<String, String>, u32);

/// What the callbacks have heard so far.
#[derive(Default)]
struct Heard {
    /// Services browsed and not resolved yet: name, type, domain, interface.
    browsed: Vec<(CString, CString, CString, u32)>,
    resolved: Vec<Resolved>,
    /// Addresses by host name.
    addresses: HashMap<String, Vec<IpAddr>>,
}

fn text(name: *const c_char) -> Option<CString> {
    (!name.is_null()).then(|| unsafe { CStr::from_ptr(name) }.to_owned())
}

extern "C" fn browsed(
    _: ServiceRef,
    flags: u32,
    interface: u32,
    error: ErrorType,
    name: *const c_char,
    regtype: *const c_char,
    domain: *const c_char,
    context: *mut c_void,
) {
    let heard = unsafe { &mut *(context as *mut Heard) };
    if error != 0 || flags & FLAGS_ADD == 0 {
        return;
    }
    if let (Some(name), Some(regtype), Some(domain)) = (text(name), text(regtype), text(domain)) {
        heard.browsed.push((name, regtype, domain, interface));
    }
}

/// The TXT record's `key=value` strings, each after its length.
pub(super) fn txt_keys(mut record: &[u8]) -> HashMap<String, String> {
    let mut keys = HashMap::new();
    while let Some((&length, rest)) = record.split_first() {
        let length = (length as usize).min(rest.len());
        let (entry, rest) = rest.split_at(length);
        let entry = String::from_utf8_lossy(entry);
        if let Some((key, value)) = entry.split_once('=') {
            keys.insert(key.to_ascii_lowercase(), value.to_owned());
        }
        record = rest;
    }
    keys
}

extern "C" fn resolved(
    _: ServiceRef,
    _: u32,
    interface: u32,
    error: ErrorType,
    full_name: *const c_char,
    host: *const c_char,
    port: u16,
    txt_length: u16,
    txt: *const u8,
    context: *mut c_void,
) {
    let heard = unsafe { &mut *(context as *mut Heard) };
    let (Some(full_name), Some(host)) = (text(full_name), text(host)) else {
        return;
    };
    if error != 0 {
        return;
    }
    let record = if txt.is_null() {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(txt, txt_length as usize) }
    };
    heard.resolved.push((
        full_name.to_string_lossy().into_owned(),
        host,
        u16::from_be(port),
        txt_keys(record),
        interface,
    ));
}

extern "C" fn addressed(
    _: ServiceRef,
    _: u32,
    _: u32,
    error: ErrorType,
    host: *const c_char,
    address: *const u8,
    _: u32,
    context: *mut c_void,
) {
    let heard = unsafe { &mut *(context as *mut Heard) };
    let Some(host) = text(host) else { return };
    if error != 0 || address.is_null() {
        return;
    }
    // A Darwin sockaddr: its length, its family, the port, then the address.
    let family = unsafe { *address.add(1) };
    let ip = match family {
        AF_INET => {
            let bytes: [u8; 4] = unsafe { std::ptr::read_unaligned(address.add(4) as *const [u8; 4]) };
            IpAddr::V4(Ipv4Addr::from(bytes))
        }
        AF_INET6 => {
            let bytes: [u8; 16] = unsafe { std::ptr::read_unaligned(address.add(8) as *const [u8; 16]) };
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return,
    };
    let list = heard.addresses.entry(host.to_string_lossy().into_owned()).or_default();
    if !list.contains(&ip) {
        list.push(ip);
    }
}

/// The services being asked of, each let go when this is dropped.
struct Asking(Vec<ServiceRef>);

impl Drop for Asking {
    fn drop(&mut self) {
        for service in self.0.drain(..) {
            unsafe { DNSServiceRefDeallocate(service) };
        }
    }
}

fn started(error: ErrorType, service: ServiceRef, asking: &mut Asking) -> Result<()> {
    if error != 0 || service.is_null() {
        return Err(Error::Discovery(format!("Bonjour said {error}")));
    }
    asking.0.push(service);
    Ok(())
}

/// The hosts that answer within `wait`, by Bonjour. Blocking.
pub fn browse(wait: Duration) -> Result<Vec<Found>> {
    // `_glazevault._tcp`, without the domain mdns-sd puts on the end.
    let regtype = CString::new(super::SERVICE.trim_end_matches('.').trim_end_matches(".local")).unwrap();
    let mut heard = Box::new(Heard::default());
    let context = &mut *heard as *mut Heard as *mut c_void;
    let mut asking = Asking(Vec::new());
    let mut service: ServiceRef = std::ptr::null_mut();
    let error = unsafe { DNSServiceBrowse(&mut service, 0, 0, regtype.as_ptr(), std::ptr::null(), browsed, context) };
    started(error, service, &mut asking)?;
    let mut hosts_asked: Vec<CString> = Vec::new();
    let deadline = Instant::now() + wait;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        // Each service browsed is resolved, and each host resolved is asked its addresses.
        for (name, regtype, domain, interface) in std::mem::take(&mut heard.browsed) {
            let mut service: ServiceRef = std::ptr::null_mut();
            let error = unsafe {
                DNSServiceResolve(
                    &mut service,
                    0,
                    interface,
                    name.as_ptr(),
                    regtype.as_ptr(),
                    domain.as_ptr(),
                    resolved,
                    context,
                )
            };
            let _ = started(error, service, &mut asking);
        }
        let hosts: Vec<(CString, u32)> = heard.resolved.iter().map(|r| (r.1.clone(), r.4)).collect();
        for (host, interface) in hosts {
            if hosts_asked.contains(&host) {
                continue;
            }
            let mut service: ServiceRef = std::ptr::null_mut();
            let error = unsafe {
                DNSServiceGetAddrInfo(
                    &mut service,
                    0,
                    interface,
                    PROTOCOL_IPV4 | PROTOCOL_IPV6,
                    host.as_ptr(),
                    addressed,
                    context,
                )
            };
            let _ = started(error, service, &mut asking);
            hosts_asked.push(host);
        }
        let mut fds: Vec<PollFd> = asking
            .0
            .iter()
            .map(|&s| PollFd {
                fd: unsafe { DNSServiceRefSockFD(s) },
                events: POLLIN,
                revents: 0,
            })
            .collect();
        let timeout = left.as_millis().min(250) as c_int;
        if unsafe { poll(fds.as_mut_ptr(), fds.len() as u32, timeout) } < 0 {
            break;
        }
        for (i, fd) in fds.iter().enumerate() {
            if fd.revents & POLLIN != 0 {
                unsafe { DNSServiceProcessResult(asking.0[i]) };
            }
        }
    }
    drop(asking);
    let suffix = format!(".{}", regtype.to_string_lossy());
    let mut hosts: Vec<Found> = Vec::new();
    for (full_name, host, port, keys, _) in &heard.resolved {
        let addresses = heard
            .addresses
            .get(&*host.to_string_lossy())
            .cloned()
            .unwrap_or_default();
        // The full name is escaped, as DNS names are: `Studio\032host._glazevault._tcp.local.`.
        let name = unescape(full_name.split(&suffix).next().unwrap_or(full_name));
        if addresses.is_empty() {
            continue;
        }
        if let Some(host) = found(name, addresses, *port, |key| keys.get(key).map(String::as_str)) {
            hosts.retain(|h| h.name != host.name);
            hosts.push(host);
        }
    }
    Ok(hosts)
}

/// A DNS name's label as it reads: `\032` is a space, `\.` a dot.
fn unescape(label: &str) -> String {
    let bytes = label.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1..i + 4].iter().all(u8::is_ascii_digit) {
            let code = std::str::from_utf8(&bytes[i + 1..i + 4])
                .unwrap()
                .parse::<u16>()
                .unwrap_or(0);
            out.push(code.min(255) as u8);
            i += 4;
        } else if bytes[i] == b'\\' && i + 1 < bytes.len() {
            out.push(bytes[i + 1]);
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_txt_record_and_an_escaped_name_read_back() {
        let record = [
            7, b'p', b'r', b'o', b't', b'o', b'=', b'3', 3, b'a', b'=', b'b', 4, b'b', b'a', b'r', b'e',
        ];
        let keys = txt_keys(&record);
        assert_eq!(keys.get("proto").map(String::as_str), Some("3"));
        assert_eq!(keys.get("a").map(String::as_str), Some("b"));
        assert_eq!(keys.len(), 2);
        assert_eq!(unescape(r"Studio\032host\.one"), "Studio host.one");
    }

    /// Bonjour finds a host `mdns-sd` advertises, as a phone would find the desktop's. Needs a
    /// network that carries multicast, so it is left out of the usual run.
    #[test]
    #[ignore]
    fn bonjour_finds_a_host_mdns_sd_advertises() {
        let key = [7u8; 32];
        let name = format!("glaze-vault-test-{}", std::process::id());
        let _advertised = super::super::advertise(&name, 47999, &key).unwrap();
        let found = browse(Duration::from_secs(5)).unwrap();
        let host = found.iter().find(|h| h.name == name).expect("the host was found");
        assert_eq!(host.port, 47999);
        assert_eq!(host.vault.as_deref(), Some(super::super::vault_tag(&key).as_str()));
        assert!(!host.addresses.is_empty());
    }
}
