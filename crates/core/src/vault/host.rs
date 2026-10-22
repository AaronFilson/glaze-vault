//! The LAN host's store (docs/adr/0020-sync-core.md): the whole vault, opened with the host's own
//! key and no collection key (the plan's question 1, ADR 18). It numbers what its computers push,
//! once each item has checked out as the vault on one computer would check it, and sends each
//! computer what its people may read, from metadata alone.

use super::events::{self, Body, SignedBy};
use super::items;
use super::signatures::Trust;
use super::team::PENDING_ORGANIZATION;
use super::{DATABASE_FILE, Held, Kind, Vault, now_ms, parse_id};
use crate::access::Directory;
use crate::crypto::{self, KeyPair, SealedBox};
use crate::error::{Error, Result};
use crate::keyring::PersonEntry;
use crate::signing::{self, As};
use crate::store;
use crate::sync::{
    Batch, DeviceCertificate, EntryItem, Item, JoinPackage, Level, OrganizationEntry, Pulled, PushResult, Refusal,
    Scope, Welcome,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

/// The host's secret, from which its X25519 key comes (plan section 2.2).
const HOST_KEY: &str = "host.key";
/// The host's database key, sealed to that key.
const HOST_FILE: &str = "host.json";
/// How many change log entries a pull reads at a time.
const PAGE: i64 = 500;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostFile {
    vault_id: Uuid,
    database_key: SealedBox,
    /// The port to listen on, if not the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
}

fn host_info(vault_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 database-key vault {vault_id} host").into_bytes()
}

/// A store's mode (plan section 2.3): `meta` says which.
pub(super) const MODE: &str = "mode";

pub struct HostStore {
    dir: PathBuf,
    conn: Connection,
    vault: Uuid,
    /// The seed of its TLS key.
    identity: Zeroizing<[u8; 32]>,
    port: Option<u16>,
}

/// A computer the host syncs with, from its certificate.
struct Device {
    people: Vec<Uuid>,
    revoked: bool,
}

impl Vault {
    /// Makes the LAN host's store from this team's vault, in `dir` (plan section 2.3.1, the steps
    /// that need no system service): a copy of the database under a new key of the host's own,
    /// without what belongs to this computer, every change numbered as the host's, and each
    /// person's key file entry, for their computers. Needs an admin, a vault changed over to
    /// summaries, and everything signed.
    pub fn prepare_host(&mut self, dir: &Path) -> Result<HostStore> {
        self.admin()?;
        if !self.summaries {
            return Err(Error::NotReadyToHost("an admin must unlock it once more first"));
        }
        if self.meta(PENDING_ORGANIZATION)?.is_some() {
            return Err(Error::NotReadyToHost("a change of organization key is not finished"));
        }
        if self.meta(MODE)?.is_some() {
            return Err(Error::NotReadyToHost("it already syncs with a host"));
        }
        self.attest()?;
        for table in ["revisions", "attachments", "events"] {
            let unsigned: i64 = self.conn.query_row(
                &format!("SELECT count(*) FROM {table} WHERE signature IS NULL"),
                [],
                |row| row.get(0),
            )?;
            if unsigned > 0 {
                return Err(Error::NotReadyToHost("some of what it holds is not signed"));
            }
        }
        if dir.join(HOST_FILE).exists() || dir.join(DATABASE_FILE).exists() {
            return Err(Error::VaultExists);
        }
        fs::create_dir_all(dir)?;
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        fs::copy(self.dir.join(DATABASE_FILE), dir.join(DATABASE_FILE))?;

        let vault_id = self.keyring.vault_id;
        let host = KeyPair::generate();
        let database_key = crypto::random_key();
        let conn = store::open(&dir.join(DATABASE_FILE), &self.database_key()?)?;
        store::rekey(&conn, &database_key)?;
        let organization = self.keyring.organization.as_ref().ok_or(Error::NotATeam)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "DELETE FROM meta WHERE name LIKE 'draft %' OR name LIKE 'settings %' OR name = 'last_backup';
             UPDATE changes SET host_seq = seq;",
        )?;
        let organization = OrganizationEntry {
            public_key: organization.public_key.clone(),
            private_key_by_recovery: organization.private_key_by_recovery.clone(),
        };
        for (name, value) in [
            (MODE, "host".to_owned()),
            ("organization", serde_json::to_string(&organization)?),
        ] {
            tx.execute("INSERT INTO meta (name, value) VALUES (?1, ?2)", params![name, value])?;
        }
        // From the key file as it is now: people set their own passwords at their first sign-in,
        // which this session's copy may not have seen.
        for user in &super::read_keyring(&self.dir)?.users {
            let entry = serde_json::to_string(&PersonEntry::of(user))?;
            let at = now_ms();
            let signature = self
                .signer
                .sign(&signing::entry_payload(&vault_id, &user.id, at, &entry));
            put_entry(
                &tx,
                &EntryItem {
                    person: user.id,
                    entry,
                    at,
                    signer: self.user_id,
                    signature,
                },
                true,
            )?;
        }
        tx.commit()?;
        drop(conn);

        let file = HostFile {
            vault_id,
            database_key: crypto::seal_key(&host.public, &database_key, &host_info(&vault_id)),
            port: None,
        };
        fs::write(dir.join(HOST_FILE), serde_json::to_vec_pretty(&file)?)?;
        write_secret(&dir.join(HOST_KEY), &host.secret)?;
        HostStore::open(dir)
    }

    /// The organization certifies a computer, for an admin: its signing key, and the people who
    /// will sign in at it, whose key file entries it gets.
    pub fn certify_device(
        &self,
        device: Uuid,
        name: &str,
        signing_key: &[u8],
        people: &[Uuid],
    ) -> Result<DeviceCertificate> {
        let organization = signing::organization_key(self.admin()?);
        // By the directory, not the key file: an admin's own computer holds only its people's.
        let directory = Directory::load(&self.conn)?;
        if people.iter().any(|p| directory.person(*p).is_none()) {
            return Err(Error::NoSuchPerson);
        }
        let issued_at = now_ms();
        let payload = signing::device_payload(&self.keyring.vault_id, &device, name, signing_key, people, issued_at);
        Ok(DeviceCertificate {
            device,
            name: name.to_owned(),
            signing_key: signing_key.to_vec(),
            people: people.to_vec(),
            issued_at,
            issuer_key: signing::public(&organization),
            signature: signing::sign(&organization, &payload),
        })
    }
}

/// Keeps a secret where only this user can read it.
fn write_secret(path: &Path, secret: &[u8]) -> Result<()> {
    crate::files::write_atomically(path, secret)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Keeps a person's newest key file entry. On the host it is also the change log's item for them,
/// moved to the end each time it changes; a replica only keeps it, to see when its own changes.
pub(super) fn put_entry(conn: &Connection, entry: &EntryItem, log: bool) -> Result<()> {
    let person = entry.person.to_string();
    conn.execute(
        "INSERT INTO key_entries (person_id, entry, at, signer_id, signature) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (person_id) DO UPDATE SET entry = excluded.entry, at = excluded.at,
             signer_id = excluded.signer_id, signature = excluded.signature",
        params![person, entry.entry, entry.at, entry.signer.to_string(), entry.signature],
    )?;
    if log {
        conn.execute(
            "DELETE FROM changes WHERE item = 'entry' AND item_id = ?1",
            params![person],
        )?;
        conn.execute(
            "INSERT INTO changes (item, item_id) VALUES ('entry', ?1)",
            params![person],
        )?;
        conn.execute(
            "UPDATE changes SET host_seq = seq WHERE item = 'entry' AND item_id = ?1",
            params![person],
        )?;
    }
    Ok(())
}

/// Which keys a computer's people hold between them, by collection: all of a collection's for an
/// admin; otherwise what each one's grants hold, every collection key standing for the narrower
/// ones made from it.
fn levels(directory: &Directory, people: &[Uuid]) -> BTreeMap<Uuid, Vec<Level>> {
    let people: Vec<Uuid> = people
        .iter()
        .copied()
        .filter(|p| directory.person(*p).is_some())
        .collect();
    let mut levels: BTreeMap<Uuid, Vec<Level>> = BTreeMap::new();
    if people.iter().any(|p| directory.is_admin(*p)) {
        for shelf in &directory.collections {
            levels.insert(shelf.id, vec![Level::Collection]);
        }
        return levels;
    }
    for grant in directory.grants.iter().filter(|g| people.contains(&g.person)) {
        let level = match directory.held(grant.role) {
            Held::Collection => Level::Collection,
            Held::Batch => Level::Batch,
            Held::Summary => Level::Summary,
        };
        levels.entry(grant.collection).or_default().push(level);
    }
    for held in levels.values_mut() {
        if held.contains(&Level::Collection) {
            *held = vec![Level::Collection];
        }
        held.sort();
        held.dedup();
    }
    levels
}

/// Whether a computer holding `levels` of a collection is sent a revision or attachment of a kind,
/// and, for a revision, whether without its ciphertext: Some(true) for a recipe's summary only.
fn sent(levels: &[Level], kind: Kind, attachment: bool) -> Option<bool> {
    if levels.contains(&Level::Collection)
        || levels.contains(&Level::Batch) && matches!(kind, Kind::Batch | Kind::Mix)
        || levels.contains(&Level::Summary) && kind == Kind::Firing
    {
        return Some(false);
    }
    (levels.contains(&Level::Summary) && kind == Kind::Recipe && !attachment).then_some(true)
}

impl HostStore {
    pub fn open(dir: &Path) -> Result<HostStore> {
        let secret = Zeroizing::new(fs::read(dir.join(HOST_KEY))?);
        let host = KeyPair::from_secret(secret).ok_or_else(|| Error::Corrupt("the host key is not valid".into()))?;
        let file: HostFile = serde_json::from_slice(&fs::read(dir.join(HOST_FILE))?)?;
        let database_key = crypto::open_key(&host, &file.database_key, &host_info(&file.vault_id))
            .ok_or_else(|| Error::Corrupt("the host's database key does not open".into()))?;
        let conn = store::open(&dir.join(DATABASE_FILE), &database_key)?;
        let mode: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE name = ?1", params![MODE], |row| {
                row.get(0)
            })
            .optional()?;
        if mode.as_deref() != Some("host") {
            return Err(Error::Corrupt("the store is not a host's".into()));
        }
        Ok(HostStore {
            dir: dir.to_owned(),
            conn,
            vault: file.vault_id,
            identity: Zeroizing::new(signing::host_key(&host).to_bytes()),
            port: file.port,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn vault_id(&self) -> Uuid {
        self.vault
    }

    /// The seed of the host's Ed25519 key, which it shows over TLS.
    pub fn identity_seed(&self) -> &Zeroizing<[u8; 32]> {
        &self.identity
    }

    /// The host's public key, which computers pin.
    pub fn identity(&self) -> Vec<u8> {
        signing::public(&ed25519_dalek::SigningKey::from_bytes(&self.identity))
    }

    /// The port `host.json` names, if any.
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// The organization's current signing key, by which a computer knows its own vault's host
    /// on the network (plan section 4.4).
    pub fn organization_key(&self) -> Result<Vec<u8>> {
        Directory::load(&self.conn)?
            .organization_keys
            .pop()
            .ok_or_else(|| Error::Corrupt("the host has no organization key".into()))
    }

    /// The computer with this signing key, if one was ever added, revoked or not.
    pub fn device_with_key(&self, signing_key: &[u8]) -> Result<Option<Uuid>> {
        let id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM devices WHERE signing_key = ?1",
                params![signing_key],
                |row| row.get(0),
            )
            .optional()?;
        id.map(|id| parse_id(&id)).transpose()
    }

    /// Whether one of a computer's people is an admin now, so it may pair others.
    pub fn is_admin_device(&self, device: Uuid) -> Result<bool> {
        let device = self.device(device)?;
        let directory = Directory::load(&self.conn)?;
        Ok(!device.revoked && device.people.iter().any(|p| directory.is_admin(*p)))
    }

    /// Lets a computer sync, from its certificate, which the organization's current key signed.
    pub fn add_device(&mut self, certificate: &DeviceCertificate) -> Result<()> {
        let directory = Directory::load(&self.conn)?;
        let c = certificate;
        let payload = signing::device_payload(&self.vault, &c.device, &c.name, &c.signing_key, &c.people, c.issued_at);
        if !directory.organization_keys.contains(&c.issuer_key)
            || !signing::verify(&c.issuer_key, &payload, &c.signature)
        {
            return Err(Error::BadSignature);
        }
        if c.people.iter().any(|p| directory.person(*p).is_none()) {
            return Err(Error::NoSuchPerson);
        }
        self.conn.execute(
            "INSERT INTO devices (id, name, signing_key, people, issued_at, issuer_key, signature)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                c.device.to_string(),
                c.name,
                c.signing_key,
                serde_json::to_string(&c.people)?,
                c.issued_at,
                c.issuer_key,
                c.signature
            ],
        )?;
        Ok(())
    }

    fn device(&self, id: Uuid) -> Result<Device> {
        let (people, revoked): (String, bool) = self
            .conn
            .query_row(
                "SELECT people, revoked_at IS NOT NULL FROM devices WHERE id = ?1",
                params![id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(Error::Revoked)?;
        Ok(Device {
            people: serde_json::from_str(&people)?,
            revoked,
        })
    }

    fn certificate(&self, id: Uuid) -> Result<DeviceCertificate> {
        type Row = (String, Vec<u8>, String, i64, Vec<u8>, Vec<u8>);
        let (name, signing_key, people, issued_at, issuer_key, signature): Row = self.conn.query_row(
            "SELECT name, signing_key, people, issued_at, issuer_key, signature FROM devices WHERE id = ?1",
            params![id.to_string()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )?;
        Ok(DeviceCertificate {
            device: id,
            name,
            signing_key,
            people: serde_json::from_str(&people)?,
            issued_at,
            issuer_key,
            signature,
        })
    }

    fn meta(&self, name: &str) -> Result<String> {
        self.conn
            .query_row("SELECT value FROM meta WHERE name = ?1", params![name], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::Corrupt(format!("the host has no {name}")))
    }

    /// What a computer needs to become a replica (replica.rs): its certificate, and its people's
    /// key file entries.
    pub fn join_package(&self, device: Uuid) -> Result<JoinPackage> {
        let certificate = self.certificate(device)?;
        let entries = certificate
            .people
            .iter()
            .map(|person| items::entry_item(&self.conn, &person.to_string()))
            .collect::<Result<_>>()?;
        Ok(JoinPackage {
            vault: self.vault,
            default_collection: parse_id(&self.meta("default_collection")?)?,
            device: certificate,
            organization: serde_json::from_str(&self.meta("organization")?)?,
            entries,
            host_key: self.identity(),
        })
    }

    /// The host's answer to a computer's hello: its scopes where what its people hold changed, to
    /// start again, and those where they hold nothing now, to drop, by what the computer last
    /// knew of them; and what they hold now, for next time.
    pub fn hello(&self, device: Uuid, known: &[(Scope, Vec<Level>)]) -> Result<Welcome> {
        let device = self.device(device)?;
        if device.revoked {
            return Ok(Welcome {
                revoked: true,
                ..Welcome::default()
            });
        }
        let now = levels(&Directory::load(&self.conn)?, &device.people);
        let mut welcome = Welcome::default();
        for (scope, before) in known {
            let Scope::Collection(collection) = scope else {
                continue;
            };
            match now.get(collection) {
                None => welcome.dropped.push(*scope),
                Some(held) if held != before => welcome.reset.push(*scope),
                Some(_) => {}
            }
        }
        welcome.levels = now
            .into_iter()
            .map(|(collection, held)| (Scope::Collection(collection), held))
            .collect();
        Ok(welcome)
    }

    /// The items after a computer's cursors that its people may read, the directory's first, up
    /// to about `max_bytes`, and the cursors after them.
    pub fn pull(&self, device: Uuid, cursors: &[(Scope, i64)], max_bytes: usize) -> Result<Batch> {
        let device = self.device(device)?;
        if device.revoked {
            return Err(Error::Revoked);
        }
        let directory = Directory::load(&self.conn)?;
        let levels = levels(&directory, &device.people);
        let admin = device.people.iter().any(|p| directory.is_admin(*p));
        let scopes =
            std::iter::once(Scope::Directory).chain(levels.keys().map(|collection| Scope::Collection(*collection)));
        let mut batch = Batch::default();
        let mut size = 0;
        'scopes: for scope in scopes {
            let mut cursor = cursors.iter().find(|(s, _)| *s == scope).map_or(0, |(_, seq)| *seq);
            let start = cursor;
            loop {
                let rows = self
                    .conn
                    .prepare(
                        "SELECT seq, item, item_id, kind FROM changes WHERE collection_id IS ?1 AND seq > ?2
                         ORDER BY seq LIMIT ?3",
                    )?
                    .query_map(params![scope.column(), cursor, PAGE], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let full = rows.len() as i64 == PAGE;
                for (seq, item, id, kind) in rows {
                    let held = match scope {
                        Scope::Collection(collection) => levels.get(&collection).map_or(&[][..], Vec::as_slice),
                        Scope::Directory => &[],
                    };
                    let kind = kind.as_deref().and_then(Kind::parse);
                    if let Some(item) = self.item_for(&directory, &device, admin, held, &item, &id, kind)? {
                        size += item.size();
                        batch.items.push(Pulled { scope, seq, item });
                    }
                    cursor = seq;
                    if size >= max_bytes {
                        batch.more = true;
                        batch.cursors.push((scope, cursor));
                        break 'scopes;
                    }
                }
                if !full {
                    break;
                }
            }
            if cursor > start {
                batch.cursors.push((scope, cursor));
            }
        }
        Ok(batch)
    }

    /// An entry of the change log as the item a computer is sent, if its people may read it.
    #[allow(clippy::too_many_arguments)]
    fn item_for(
        &self,
        directory: &Directory,
        device: &Device,
        admin: bool,
        held: &[Level],
        item: &str,
        id: &str,
        kind: Option<Kind>,
    ) -> Result<Option<Item>> {
        Ok(match (item, kind) {
            ("revision", Some(kind)) => match sent(held, kind, false) {
                Some(stripped) => Some(Item::Revision(items::revision_item(&self.conn, id, stripped)?)),
                None => None,
            },
            ("attachment", Some(kind)) => match sent(held, kind, true) {
                Some(_) => Some(Item::Attachment(items::attachment_item(&self.conn, id)?)),
                None => None,
            },
            ("event", _) => {
                let event = items::event_item(&self.conn, id)?;
                let body: Body = serde_json::from_str(&event.body)?;
                let shown = match &body {
                    Body::GrantSet { person, collection, .. } | Body::GrantRemoved { person, collection } => {
                        admin
                            || device.people.contains(person)
                            || device.people.iter().any(|p| directory.may_manage(*p, *collection))
                    }
                    Body::OrganizationGrantSet { .. } => admin,
                    _ => true,
                };
                shown.then_some(Item::Event(event))
            }
            ("entry", _) => {
                let person = parse_id(id)?;
                device
                    .people
                    .contains(&person)
                    .then(|| items::entry_item(&self.conn, id))
                    .transpose()?
                    .map(Item::Entry)
            }
            _ => None,
        })
    }

    /// Checks and numbers what a computer pushes. Revisions, attachments and key file entries are
    /// taken each on its own: one refused does not keep the others out. Events that follow one
    /// another were made together, as taking a role away is its grant removed, a new key epoch
    /// and everyone's grants sealed again, so they are taken all or none. Items the host has
    /// already are taken again, with the numbers they had.
    pub fn accept(&mut self, device: Uuid, items: Vec<Item>) -> Result<PushResult> {
        let device = self.device(device)?;
        let mut result = PushResult::default();
        if device.revoked {
            result.refused = items.iter().map(|item| (item.id(), Refusal::NotAllowed)).collect();
            return Ok(result);
        }
        let mut rest = items.as_slice();
        while let Some(first) = rest.first() {
            let run = if matches!(first, Item::Event(_)) {
                rest.iter().take_while(|item| matches!(item, Item::Event(_))).count()
            } else {
                1
            };
            let (group, after) = rest.split_at(run);
            rest = after;
            self.conn.execute_batch("SAVEPOINT items")?;
            let mut accepted = Vec::new();
            let mut refused = None;
            for item in group {
                match self.accept_one(&device, item) {
                    Ok(Ok(seq)) => accepted.push((item.id(), seq)),
                    Ok(Err(refusal)) => {
                        refused = Some((item.id(), refusal));
                        break;
                    }
                    Err(error) => {
                        let _ = self.conn.execute_batch("ROLLBACK TO items; RELEASE items");
                        return Err(error);
                    }
                }
            }
            match refused {
                None => {
                    self.conn.execute_batch("RELEASE items")?;
                    result.accepted.extend(accepted);
                }
                Some((id, refusal)) => {
                    self.conn.execute_batch("ROLLBACK TO items; RELEASE items")?;
                    for item in group {
                        let why = if item.id() == id {
                            refusal.clone()
                        } else {
                            invalid("it was made with a change that was refused")
                        };
                        result.refused.push((item.id(), why));
                    }
                }
            }
        }
        Ok(result)
    }

    fn accept_one(&self, device: &Device, item: &Item) -> Result<std::result::Result<i64, Refusal>> {
        let conn = &self.conn;
        let trust = Trust::load(conn, self.vault)?;
        let directory = Directory::load(conn)?;
        match item {
            Item::Revision(r) => {
                if items::exists(conn, "revisions", &r.id)? {
                    return self.again(conn, "revisions", &r.id, &r.signed.signature);
                }
                let signed = match items::check_revision(&trust, &self.vault, r) {
                    Ok(signed) => signed,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                if let Err(refusal) = self.may_save(
                    conn,
                    &directory,
                    device,
                    &signed,
                    r.record,
                    r.kind,
                    r.collection,
                    r.author,
                    r.epoch,
                )? {
                    return Ok(Err(refusal));
                }
                // Its place in the record's history: after a revision of the same record, in the
                // collection the record is in.
                let parent: Option<(String, String, String, i64)> = match r.parent {
                    Some(parent) => conn
                        .query_row(
                            "SELECT record_id, kind, collection_id, number FROM revisions WHERE id = ?1",
                            params![parent.to_string()],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                        )
                        .optional()?,
                    None => None,
                };
                match (&r.parent, parent) {
                    (Some(_), None) => return Ok(Err(Refusal::ParentUnknown)),
                    (Some(_), Some((record, kind, collection, number)))
                        if record != r.record.to_string()
                            || kind != r.kind.as_str()
                            || collection != r.collection.to_string()
                            || number + 1 != r.number =>
                    {
                        return Ok(Err(invalid("its parent is another record's, or not the one before it")));
                    }
                    (None, _) if r.number != 1 => return Ok(Err(invalid("a record's first revision is number 1"))),
                    _ => {}
                }
                let elsewhere: Option<String> = conn
                    .query_row(
                        "SELECT collection_id FROM revisions WHERE record_id = ?1 AND kind = ?2 AND collection_id != ?3 LIMIT 1",
                        params![r.record.to_string(), r.kind.as_str(), r.collection.to_string()],
                        |row| row.get(0),
                    )
                    .optional()?;
                if elsewhere.is_some() {
                    return Ok(Err(invalid("its record is in another collection")));
                }
                items::store_revision(conn, r)?;
                let seq = items::log(conn, "revision", &r.id, &r.collection, r.kind, None)?;
                self.numbered(conn, &r.id)?;
                Ok(Ok(seq))
            }
            Item::Attachment(a) => {
                if items::exists(conn, "attachments", &a.id)? {
                    return self.again(conn, "attachments", &a.id, &a.signed.signature);
                }
                let signed = match items::check_attachment(&trust, &self.vault, a) {
                    Ok(signed) => signed,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                if let Err(refusal) = self.may_save(
                    conn,
                    &directory,
                    device,
                    &signed,
                    a.record,
                    a.kind,
                    a.collection,
                    a.author,
                    a.epoch,
                )? {
                    return Ok(Err(refusal));
                }
                let record: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM revisions WHERE record_id = ?1 AND kind = ?2 AND collection_id = ?3 LIMIT 1",
                        params![a.record.to_string(), a.kind.as_str(), a.collection.to_string()],
                        |row| row.get(0),
                    )
                    .optional()?;
                if record.is_none() {
                    return Ok(Err(Refusal::ParentUnknown));
                }
                items::store_attachment(conn, a)?;
                let seq = items::log(conn, "attachment", &a.id, &a.collection, a.kind, None)?;
                self.numbered(conn, &a.id)?;
                Ok(Ok(seq))
            }
            Item::Event(e) => {
                if items::exists(conn, "events", &e.id)? {
                    return self.again(conn, "events", &e.id, &e.signed.signature);
                }
                let event = match items::event_of(e) {
                    Ok(event) => event,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let signed = event.signed.clone().expect("event_of signs");
                let Some(actor) = event.actor else {
                    return Ok(Err(Refusal::NotAllowed));
                };
                if signed.role != As::Author || signed.signer != actor || !device.people.contains(&actor) {
                    return Ok(Err(Refusal::NotAllowed));
                }
                if let Err(refusal) = trust.check_now(&signed, &event.payload(&self.vault, signed.role, &signed.signer))
                {
                    return Ok(Err(refusal));
                }
                if let Err(error) = directory.check(actor, &event.body) {
                    return Ok(Err(refusal_for(error)));
                }
                if let Body::Erased { record, kind, .. } = &event.body
                    && !all_heads_deleted(conn, record, *kind)?
                {
                    return Ok(Err(Refusal::ChangedElsewhere));
                }
                events::apply(conn, &event)?;
                self.numbered(conn, &event.id).map(Ok)
            }
            Item::Entry(entry) => {
                let Some(parsed) = entry.parsed() else {
                    return Ok(Err(invalid("the key file entry does not read")));
                };
                if parsed.id != entry.person || directory.person(entry.person).is_none() {
                    return Ok(Err(invalid("the key file entry is not its person's")));
                }
                let public_key: Vec<u8> = conn.query_row(
                    "SELECT public_key FROM people WHERE id = ?1",
                    params![entry.person.to_string()],
                    |row| row.get(0),
                )?;
                if parsed.public_key != public_key {
                    return Ok(Err(invalid("the key file entry has other keys than the person's")));
                }
                if !device.people.contains(&entry.signer)
                    || entry.signer != entry.person && !directory.is_admin(entry.signer)
                {
                    return Ok(Err(Refusal::NotAllowed));
                }
                let signed = SignedBy {
                    signature: entry.signature.clone(),
                    signer: entry.signer,
                    role: As::Author,
                };
                let payload = signing::entry_payload(&self.vault, &entry.person, entry.at, &entry.entry);
                if let Err(refusal) = trust.check_now(&signed, &payload) {
                    return Ok(Err(refusal));
                }
                let newer: Option<i64> = conn
                    .query_row(
                        "SELECT at FROM key_entries WHERE person_id = ?1 AND at > ?2",
                        params![entry.person.to_string(), entry.at],
                        |row| row.get(0),
                    )
                    .optional()?;
                if newer.is_none() {
                    put_entry(conn, entry, true)?;
                }
                Ok(Ok(conn.query_row(
                    "SELECT seq FROM changes WHERE item = 'entry' AND item_id = ?1",
                    params![entry.person.to_string()],
                    |row| row.get(0),
                )?))
            }
        }
    }

    /// Whether a computer's person may save a revision or attachment in a collection: its author,
    /// or whoever moved its record there, under the collection's current key, in a record that
    /// was not erased.
    #[allow(clippy::too_many_arguments)]
    fn may_save(
        &self,
        conn: &Connection,
        directory: &Directory,
        device: &Device,
        signed: &SignedBy,
        record: Uuid,
        kind: Kind,
        collection: Uuid,
        author: Uuid,
        epoch: i64,
    ) -> Result<std::result::Result<(), Refusal>> {
        let allowed = device.people.contains(&signed.signer)
            && directory.may_change(signed.signer, collection, kind)
            && match signed.role {
                As::Author => signed.signer == author,
                As::Mover => moved_into(conn, &record, kind, &collection)?,
                As::Attester => false,
            };
        if !allowed {
            return Ok(Err(Refusal::NotAllowed));
        }
        let current = directory.collection(collection).map_or(0, |c| c.epoch);
        if epoch != current {
            return Ok(Err(Refusal::StaleEpoch { current }));
        }
        let erased: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM erased WHERE record_id = ?1",
                params![record.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        Ok(if erased.is_some() { Err(Refusal::Erased) } else { Ok(()) })
    }

    /// An item it has already, pushed again because the answer was lost: taken, with its number,
    /// if it is the same one.
    fn again(
        &self,
        conn: &Connection,
        table: &str,
        id: &Uuid,
        signature: &[u8],
    ) -> Result<std::result::Result<i64, Refusal>> {
        let stored: Option<Vec<u8>> = conn.query_row(
            &format!("SELECT signature FROM {table} WHERE id = ?1"),
            params![id.to_string()],
            |row| row.get(0),
        )?;
        if stored.as_deref() != Some(signature) {
            return Ok(Err(invalid("another item has its id")));
        }
        Ok(Ok(conn.query_row(
            "SELECT max(seq) FROM changes WHERE item_id = ?1",
            params![id.to_string()],
            |row| row.get(0),
        )?))
    }

    /// Gives what was just logged for an item the host's numbers: on the host they are its own.
    fn numbered(&self, conn: &Connection, id: &Uuid) -> Result<i64> {
        conn.execute(
            "UPDATE changes SET host_seq = seq WHERE item_id = ?1 AND host_seq IS NULL",
            params![id.to_string()],
        )?;
        Ok(conn.query_row(
            "SELECT max(seq) FROM changes WHERE item_id = ?1",
            params![id.to_string()],
            |row| row.get(0),
        )?)
    }
}

fn invalid(reason: &str) -> Refusal {
    Refusal::Invalid {
        reason: reason.to_owned(),
    }
}

/// What a computer is told when the directory refuses an event.
fn refusal_for(error: Error) -> Refusal {
    match error {
        Error::NotAllowed | Error::ManagersOnlyLower | Error::NotATeam | Error::RemovingAdmin => Refusal::NotAllowed,
        Error::BadSignature => Refusal::BadSignature,
        other => Refusal::Invalid {
            reason: other.to_string(),
        },
    }
}

/// Whether a record was moved into a collection, by a move the host has.
fn moved_into(conn: &Connection, record: &Uuid, kind: Kind, collection: &Uuid) -> Result<bool> {
    let bodies = conn
        .prepare("SELECT body FROM events WHERE type = 'moved' AND collection_id = ?1")?
        .query_map(params![collection.to_string()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for body in bodies {
        if let Body::Moved {
            record: moved, kind: k, ..
        } = serde_json::from_str(&body)?
            && moved == *record
            && k == kind
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether every newest revision of a record deletes it, so erasing it loses nothing someone
/// changed since (plan section 1.4).
fn all_heads_deleted(conn: &Connection, record: &Uuid, kind: Kind) -> Result<bool> {
    let superseded: Vec<String> = conn
        .prepare("SELECT supersedes FROM revisions WHERE record_id = ?1 AND kind = ?2 AND supersedes IS NOT NULL")?
        .query_map(params![record.to_string(), kind.as_str()], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .flat_map(|list| list.split(',').map(str::to_owned).collect::<Vec<_>>())
        .collect();
    let heads = conn
        .prepare(
            "SELECT r.id, r.deleted FROM revisions r WHERE r.record_id = ?1 AND r.kind = ?2
             AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)",
        )?
        .query_map(params![record.to_string(), kind.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(!heads.is_empty()
        && heads
            .iter()
            .filter(|(id, _)| !superseded.contains(id))
            .all(|(_, deleted)| *deleted))
}
