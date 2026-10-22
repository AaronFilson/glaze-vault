//! Host mode on the host computer (docs/adr/0022-host-mode.md): the vault's app there becomes the
//! host's first computer, a replica over loopback, and can become a vault on one computer again
//! when the host stops serving.

use super::host::{MODE, put_entry};
use super::{HostStore, Vault};
use crate::access::Directory;
use crate::error::{Error, Result};
use crate::sync::DeviceKey;
use rusqlite::params;
use std::path::Path;
use uuid::Uuid;

/// What a replica keeps in `meta` that a vault on one computer does not.
const REPLICA_META: [&str; 6] = [
    MODE,
    "device",
    "device_key",
    "device_certificate",
    "host_key",
    "host_address",
];

impl Vault {
    /// Makes the host's store in `staging` (prepare_host), and this vault its first computer, for
    /// everyone in the vault, who all sign in here today. It has everything the host has, so it
    /// has nothing to push: each change is marked as the host's, under the same number. The host
    /// is at `address`, on this computer.
    pub fn convert_to_host(&mut self, staging: &Path, address: &str) -> Result<HostStore> {
        let mut host = self.prepare_host(staging)?;
        let device = DeviceKey::generate();
        let people: Vec<Uuid> = Directory::load(&self.conn)?.people.iter().map(|p| p.id).collect();
        let certificate = self.certify_device(device.id, "The host computer", &device.public(), &people)?;
        host.add_device(&certificate)?;
        let entries = host.join_package(device.id)?.entries;
        let tx = self.conn.unchecked_transaction()?;
        for entry in &entries {
            put_entry(&tx, entry, false)?;
        }
        for (name, value) in [
            (MODE, "replica".to_owned()),
            ("device", device.id.to_string()),
            ("device_key", hex::encode(*device.seed)),
            ("device_certificate", serde_json::to_string(&certificate)?),
            ("host_key", hex::encode(host.identity())),
            ("host_address", address.to_owned()),
        ] {
            tx.execute("INSERT INTO meta (name, value) VALUES (?1, ?2)", params![name, value])?;
        }
        tx.execute("UPDATE changes SET host_seq = seq WHERE host_seq IS NULL", [])?;
        tx.commit()?;
        Ok(host)
    }

    /// Where this replica last reached its host.
    pub fn host_address(&self) -> Result<Option<String>> {
        self.meta("host_address")
    }

    pub fn set_host_address(&mut self, address: &str) -> Result<()> {
        if !self.is_replica() {
            return Err(Error::NotAllowed);
        }
        self.set_meta("host_address", address)
    }

    /// Makes this replica a vault on one computer again, for an admin, once the host has stopped
    /// serving. What it never got from the host, such as work on computers that had not synced,
    /// is not here.
    pub fn stop_syncing(&mut self) -> Result<()> {
        self.admin()?;
        if !self.is_replica() {
            return Err(Error::NotAllowed);
        }
        let tx = self.conn.unchecked_transaction()?;
        for name in REPLICA_META {
            tx.execute("DELETE FROM meta WHERE name = ?1", params![name])?;
        }
        tx.execute_batch("DELETE FROM sync_state; DELETE FROM refused;")?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{Kind, Role, Vault};
    use serde_json::json;

    #[test]
    fn the_host_computers_vault_becomes_a_replica_with_nothing_to_push_and_back() {
        let (dir, staging) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = Vault::create(dir.path(), "cone six oxidation").unwrap();
        vault.grow_into_team("Ana").unwrap();
        let shared = vault.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let ben = vault
            .add_person("Ben", "pass this on", &[(shared, Role::Formulator)])
            .unwrap();
        vault
            .save_in(
                Kind::Recipe,
                shared,
                &json!({ "name": "Shino", "lines": [], "notes": "" }),
            )
            .unwrap();
        let staging = staging.path().join("host");
        let host = vault.convert_to_host(&staging, "127.0.0.1:47917").unwrap();
        assert!(vault.is_replica());
        assert_eq!(vault.host_key().unwrap(), host.identity());
        assert_eq!(vault.host_address().unwrap().as_deref(), Some("127.0.0.1:47917"));
        assert!(vault.pending(usize::MAX).unwrap().is_empty());
        let devices = host.devices().unwrap();
        assert_eq!(devices.len(), 1);
        assert!(devices[0].people.contains(&ben.id));

        vault.stop_syncing().unwrap();
        assert!(!vault.is_replica());
        assert!(vault.host_address().unwrap().is_none());
        assert_eq!(vault.heads(Kind::Recipe).unwrap().len(), 1);
    }
}
