//! What each person may do in a collection (docs/adr/0004-roles-and-collections.md, 0012). Every
//! command is checked here, in the core; the UI only hides what would be refused.
//!
//! The checks read a [`Directory`]: who is in the vault, its collections, who holds what role on
//! each, and the roles admins made. It is metadata only, so a store that holds no collection key,
//! as the LAN host will, makes the same checks as the vault on one computer (ADR 18).

use crate::error::{Error, Result};
use crate::signing;
use crate::vault::{Body, Capabilities, CustomRole, Held, Kind};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

/// A set of capabilities, given to a person on a collection. A one-person vault's only person is
/// an admin of its only collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Reads batch sheets and logs mixes of them, and nothing else: no recipes, materials or
    /// chemistry. Their grant holds only the collection's batch key (crate::vault::batch_key).
    Operator,
    /// Reads recipes, materials and their chemistry.
    Chemist,
    /// Also logs mixes and firings, with their photos, and changes nothing else: someone who
    /// mixes and fires tests.
    Tester,
    /// Also makes, changes, deletes and erases them.
    Formulator,
    /// Everything, on every collection, with people, collections and backups.
    Admin,
    /// One an admin made (crate::vault::CustomRole): reads everything, as a chemist does, and
    /// changes the kinds of record it names.
    Custom(Uuid),
}

const CUSTOM: &str = "role:";

impl Role {
    /// How the role is kept in the database and named to the page: "chemist", or "role:" and a
    /// custom role's id.
    pub fn code(self) -> String {
        match self {
            Role::Operator => "operator".into(),
            Role::Chemist => "chemist".into(),
            Role::Tester => "tester".into(),
            Role::Formulator => "formulator".into(),
            Role::Admin => "admin".into(),
            Role::Custom(id) => format!("{CUSTOM}{id}"),
        }
    }

    pub fn parse(text: &str) -> Option<Role> {
        match text {
            "operator" => Some(Role::Operator),
            "chemist" => Some(Role::Chemist),
            "tester" => Some(Role::Tester),
            "formulator" => Some(Role::Formulator),
            "admin" => Some(Role::Admin),
            _ => Uuid::parse_str(text.strip_prefix(CUSTOM)?).ok().map(Role::Custom),
        }
    }

    /// Whether the role may make, change, delete and erase records of a kind. A custom role's
    /// kinds are its own, so it says nothing here.
    pub fn changes(self, kind: Kind) -> Option<bool> {
        match self {
            Role::Operator => Some(kind == Kind::Mix),
            Role::Chemist => Some(false),
            Role::Tester => Some(matches!(kind, Kind::Firing | Kind::Mix)),
            Role::Formulator | Role::Admin => Some(true),
            Role::Custom(_) => None,
        }
    }
}

impl Serialize for Role {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.code())
    }
}

impl<'de> Deserialize<'de> for Role {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Role::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("unknown role {text}")))
    }
}

/// The built-in roles' names, which a role an admin makes cannot take.
const BUILT_IN_NAMES: [&str; 6] = ["batch operator", "operator", "chemist", "tester", "formulator", "admin"];

/// What the checks read, from the tables the directory's events write (vault::events).
#[derive(Debug, Clone, Default)]
pub(crate) struct Directory {
    /// Everyone in the vault now; those removed are left out.
    pub people: Vec<Member>,
    pub collections: Vec<Shelf>,
    pub grants: Vec<Granted>,
    pub roles: Vec<CustomRole>,
    /// The vault's id, which signatures name.
    pub vault: Uuid,
    /// The organization's signing key now, which issues certificates: at most one.
    pub organization_keys: Vec<Vec<u8>>,
    /// The rule for computers away from the host (ADR 24).
    pub offline_policy: crate::vault::OfflinePolicy,
}

#[derive(Debug, Clone)]
pub(crate) struct Member {
    pub id: Uuid,
    pub name: String,
    pub admin: bool,
}

/// A collection, as the checks see it: not its name or keys.
#[derive(Debug, Clone)]
pub(crate) struct Shelf {
    pub id: Uuid,
    /// The person whose private collection it is.
    pub owner: Option<Uuid>,
    pub epoch: i64,
}

/// A person's role on a collection, and the key epoch their grant is sealed at.
#[derive(Debug, Clone)]
pub(crate) struct Granted {
    pub person: Uuid,
    pub collection: Uuid,
    pub role: Role,
    pub epoch: i64,
}

impl Directory {
    pub fn load(conn: &Connection) -> Result<Directory> {
        let mut statement =
            conn.prepare("SELECT id, name, admin FROM people WHERE removed_at IS NULL ORDER BY added_at, rowid")?;
        let people = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(id, name, admin)| {
                Ok(Member {
                    id: parse_id(&id)?,
                    name,
                    admin,
                })
            })
            .collect::<Result<_>>()?;
        let mut statement = conn.prepare("SELECT id, owner_id, epoch FROM collections ORDER BY created_at, rowid")?;
        let collections = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(id, owner, epoch)| {
                Ok(Shelf {
                    id: parse_id(&id)?,
                    owner: owner.as_deref().map(parse_id).transpose()?,
                    epoch,
                })
            })
            .collect::<Result<_>>()?;
        let mut statement =
            conn.prepare("SELECT user_id, collection_id, role, epoch FROM grants ORDER BY user_id, rowid")?;
        let grants = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(person, collection, role, epoch)| {
                Ok(Granted {
                    person: parse_id(&person)?,
                    collection: parse_id(&collection)?,
                    role: Role::parse(&role).ok_or_else(|| Error::Corrupt(format!("unknown role {role}")))?,
                    epoch,
                })
            })
            .collect::<Result<_>>()?;
        let mut statement = conn.prepare("SELECT id, name, changes, may FROM roles ORDER BY created_at, rowid")?;
        let roles = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(id, name, changes, may)| {
                Ok(CustomRole {
                    id: parse_id(&id)?,
                    name,
                    changes: changes.split(',').filter_map(Kind::parse).collect(),
                    may: Capabilities::parse(&may),
                })
            })
            .collect::<Result<_>>()?;
        let vault: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE name = 'vault_id'", [], |row| row.get(0))
            .optional()?;
        let organization_keys = conn
            .prepare("SELECT signing_key FROM organization_keys WHERE retired_at IS NULL ORDER BY added_at")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<Vec<u8>>>>()?;
        let offline_policy: Option<String> = conn
            .query_row("SELECT policy FROM offline_policy WHERE id = 1", [], |row| row.get(0))
            .optional()?;
        Ok(Directory {
            people,
            collections,
            grants,
            roles,
            vault: vault.as_deref().map(parse_id).transpose()?.unwrap_or_default(),
            organization_keys,
            offline_policy: offline_policy
                .map(|p| serde_json::from_str(&p))
                .transpose()?
                .unwrap_or_default(),
        })
    }

    /// A team's vault has admins; a one-person vault has its one person and no admin (ADR 6).
    pub fn is_team(&self) -> bool {
        self.people.iter().any(|p| p.admin)
    }

    pub fn is_admin(&self, person: Uuid) -> bool {
        self.person(person).is_some_and(|p| p.admin)
    }

    pub fn person(&self, id: Uuid) -> Option<&Member> {
        self.people.iter().find(|p| p.id == id)
    }

    pub fn collection(&self, id: Uuid) -> Option<&Shelf> {
        self.collections.iter().find(|c| c.id == id)
    }

    pub fn grant(&self, person: Uuid, collection: Uuid) -> Option<&Granted> {
        self.grants
            .iter()
            .find(|g| g.person == person && g.collection == collection)
    }

    /// Whether a role lets someone make and change records of a kind. A custom role that reads
    /// without chemistry changes firings at most.
    pub fn changes(&self, role: Role, kind: Kind) -> bool {
        match (role.changes(kind), role) {
            (Some(may), _) => may,
            (None, Role::Custom(id)) => self
                .roles
                .iter()
                .any(|r| r.id == id && r.changes.contains(&kind) && (r.may.chemistry || kind == Kind::Firing)),
            (None, _) => false,
        }
    }

    /// What a role may do besides changing records. A batch operator reads no chemistry, but
    /// prints and exports its batch sheets as before.
    pub fn capabilities(&self, role: Role) -> Capabilities {
        match role {
            Role::Operator => Capabilities {
                chemistry: false,
                ..Capabilities::BUILT_IN
            },
            Role::Custom(id) => self
                .roles
                .iter()
                .find(|r| r.id == id)
                .map_or(Capabilities::NONE, |r| r.may),
            _ => Capabilities::BUILT_IN,
        }
    }

    /// Which key a grant of a role holds.
    pub fn held(&self, role: Role) -> Held {
        match role {
            Role::Operator => Held::Batch,
            Role::Custom(_) if !self.capabilities(role).chemistry => Held::Summary,
            _ => Held::Collection,
        }
    }

    /// Whether someone may make and change records of a kind in a collection. An admin may in
    /// every one.
    pub fn may_change(&self, person: Uuid, collection: Uuid, kind: Kind) -> bool {
        self.collection(collection).is_some()
            && (self.is_admin(person)
                || self
                    .grant(person, collection)
                    .is_some_and(|g| self.changes(g.role, kind)))
    }

    /// Whether someone manages a collection in a team's vault: gives and takes away roles on it,
    /// and renames it. An admin manages every one; nobody else manages a person's private one.
    pub fn may_manage(&self, person: Uuid, collection: Uuid) -> bool {
        let Some(shelf) = self.collection(collection) else {
            return false;
        };
        self.is_team()
            && (self.is_admin(person)
                || shelf.owner.is_none()
                    && self
                        .grant(person, collection)
                        .is_some_and(|g| self.capabilities(g.role).manage))
    }

    /// Whether someone decides everything in the vault: an admin of a team's, or the person of a
    /// one-person vault.
    fn in_charge(&self, person: Uuid) -> bool {
        self.is_admin(person) || !self.is_team() && self.person(person).is_some()
    }

    /// A role someone who is not an admin may give or take away: not an admin's or a manager's.
    fn lower(&self, role: Role) -> bool {
        role != Role::Admin && !self.capabilities(role).manage
    }

    /// Whether `actor` may make a change to the directory, or erase or move a record, given the
    /// directory as it is before it. The same check runs wherever a change is applied: in the
    /// vault on one computer now, and on the LAN host for what devices send it.
    pub fn check(&self, actor: Uuid, body: &Body) -> Result<()> {
        // A vault's first person adds themselves, and nothing else happens before.
        if self.people.is_empty() {
            return match body {
                Body::PersonAdded { person, .. } if *person == actor => Ok(()),
                _ => Err(Error::NotAllowed),
            };
        }
        if self.person(actor).is_none() {
            return Err(Error::NotAllowed);
        }
        let team = || if self.is_team() { Ok(()) } else { Err(Error::NotATeam) };
        let in_charge = || {
            if self.in_charge(actor) {
                Ok(())
            } else {
                Err(Error::NotAllowed)
            }
        };
        let person = |id: &Uuid| self.person(*id).ok_or(Error::NoSuchPerson);
        let collection = |id: &Uuid| self.collection(*id).ok_or(Error::NotFound);
        let in_charge_or_manager = |id: &Uuid| {
            if self.in_charge(actor) || self.may_manage(actor, *id) {
                Ok(())
            } else {
                Err(Error::NotAllowed)
            }
        };
        match body {
            Body::PersonAdded { person: id, name, .. } => {
                in_charge()?;
                team()?;
                if self.person(*id).is_some() {
                    return Err(Error::Corrupt(format!("person {id} is already in the vault")));
                }
                self.check_person_name(name, *id)
            }
            Body::PersonKeysChanged { person: id, .. } => {
                person(id)?;
                if *id == actor { Ok(()) } else { in_charge() }
            }
            Body::PersonRemoved { person: id } => {
                in_charge()?;
                team()?;
                // Nobody removes themselves.
                if *id == actor {
                    return Err(Error::NotAllowed);
                }
                // An admin holds the organization's key, so admin is taken away first.
                if person(id)?.admin {
                    Err(Error::RemovingAdmin)
                } else {
                    Ok(())
                }
            }
            Body::AdminGiven { person: id } => {
                in_charge()?;
                team()?;
                person(id).map(|_| ())
            }
            Body::AdminTaken { person: id, .. } => {
                in_charge()?;
                team()?;
                if *id == actor {
                    return Err(Error::NotAllowed);
                }
                if person(id)?.admin {
                    Ok(())
                } else {
                    Err(Error::NotAnAdmin)
                }
            }
            Body::TeamFormed { person: id, name, .. } => {
                if self.is_team() {
                    return Err(Error::AlreadyATeam);
                }
                if *id != actor || self.people.len() != 1 {
                    return Err(Error::NotAllowed);
                }
                self.check_person_name(name, *id)
            }
            Body::TeamDisbanded { renamed } => {
                in_charge()?;
                team()?;
                for shelf in renamed {
                    collection(&shelf.collection)?;
                }
                Ok(())
            }
            Body::CollectionCreated {
                collection: id, owner, ..
            } => {
                in_charge()?;
                if self.collection(*id).is_some() {
                    return Err(Error::Corrupt(format!("collection {id} is already in the vault")));
                }
                owner.as_ref().map_or(Ok(()), |owner| person(owner).map(|_| ()))
            }
            Body::CollectionRenamed { collection: id, name } => {
                team()?;
                let shelf = collection(id)?;
                if name.trim().is_empty() {
                    return Err(Error::NameMissing);
                }
                in_charge_or_manager(id)?;
                // A private collection keeps the name it has.
                if shelf.owner.is_some() {
                    Err(Error::NotAllowed)
                } else {
                    Ok(())
                }
            }
            Body::KeyEpoch {
                collection: id, epoch, ..
            } => {
                let shelf = collection(id)?;
                in_charge_or_manager(id)?;
                if *epoch != shelf.epoch + 1 {
                    return Err(Error::Corrupt(format!(
                        "collection {id} is at key epoch {}, not {}",
                        shelf.epoch,
                        epoch - 1
                    )));
                }
                Ok(())
            }
            Body::GrantSet {
                person: id,
                collection: on,
                role,
                epoch,
                ..
            } => {
                let shelf = collection(on)?;
                person(id)?;
                if let Role::Custom(custom) = role
                    && !self.roles.iter().any(|r| r.id == *custom)
                {
                    return Err(Error::NoSuchRole);
                }
                if *epoch != shelf.epoch {
                    return Err(Error::Corrupt(format!(
                        "a grant on collection {on} is sealed at key epoch {epoch}, not {}",
                        shelf.epoch
                    )));
                }
                if self.in_charge(actor) {
                    return Ok(());
                }
                if !self.may_manage(actor, *on) {
                    return Err(Error::NotAllowed);
                }
                let previous = self.grant(*id, *on);
                // After a new key epoch, whoever started it seals everyone's grant again, as it was.
                if previous.is_some_and(|g| g.role == *role && g.epoch < shelf.epoch) {
                    return Ok(());
                }
                if *id == actor
                    || self.is_admin(*id)
                    || previous.is_some_and(|g| !self.lower(g.role))
                    || !self.lower(*role)
                {
                    return Err(Error::ManagersOnlyLower);
                }
                Ok(())
            }
            Body::GrantRemoved {
                person: id,
                collection: on,
            } => {
                collection(on)?;
                let previous = self.grant(*id, *on).ok_or(Error::NotFound)?;
                if self.in_charge(actor) {
                    return Ok(());
                }
                if !self.may_manage(actor, *on) {
                    return Err(Error::NotAllowed);
                }
                if *id == actor || self.is_admin(*id) || !self.lower(previous.role) {
                    return Err(Error::ManagersOnlyLower);
                }
                Ok(())
            }
            Body::OrganizationGrantSet {
                collection: on, epoch, ..
            } => {
                team()?;
                let shelf = collection(on)?;
                in_charge_or_manager(on)?;
                if *epoch != shelf.epoch {
                    return Err(Error::Corrupt(format!(
                        "collection {on} is sealed to the organization at key epoch {epoch}, not {}",
                        shelf.epoch
                    )));
                }
                Ok(())
            }
            Body::CertificateIssued {
                person: id,
                signing_key,
                encryption_key,
                issued_at,
                issuer_key,
                signature,
                ..
            } => {
                person(id)?;
                let payload = signing::certificate_payload(&self.vault, id, signing_key, encryption_key, *issued_at);
                if !signing::verify(issuer_key, &payload, signature) {
                    return Err(Error::BadSignature);
                }
                // Someone vouches for their own key; only an admin, with an organization key the
                // vault knows, for anyone's.
                let own = issuer_key == signing_key && *id == actor;
                if own || self.in_charge(actor) && self.organization_keys.contains(issuer_key) {
                    Ok(())
                } else {
                    Err(Error::NotAllowed)
                }
            }
            Body::OrganizationKeyAdded {
                signing_key,
                encryption_key,
                signature,
            } => {
                in_charge()?;
                team()?;
                let payload = signing::organization_key_payload(&self.vault, signing_key, encryption_key);
                if signing::verify(signing_key, &payload, signature) {
                    Ok(())
                } else {
                    Err(Error::BadSignature)
                }
            }
            Body::RoleCreated { role } => {
                in_charge()?;
                team()?;
                if self.roles.iter().any(|r| r.id == role.id) {
                    return Err(Error::Corrupt(format!("role {} is already in the vault", role.id)));
                }
                self.check_role(role)
            }
            Body::RoleChanged { role } => {
                in_charge()?;
                team()?;
                if !self.roles.iter().any(|r| r.id == role.id) {
                    return Err(Error::NoSuchRole);
                }
                self.check_role(role)
            }
            Body::OfflinePolicySet { policy } => {
                in_charge()?;
                team()?;
                policy.check()
            }
            Body::RoleDeleted { role } => {
                in_charge()?;
                if self.grants.iter().any(|g| g.role == Role::Custom(*role)) {
                    return Err(Error::RoleInUse);
                }
                if self.roles.iter().any(|r| r.id == *role) {
                    Ok(())
                } else {
                    Err(Error::NoSuchRole)
                }
            }
            Body::Erased {
                kind, collection: in_, ..
            } => {
                collection(in_)?;
                if self.may_change(actor, *in_, *kind) {
                    Ok(())
                } else {
                    Err(Error::NotAllowed)
                }
            }
            Body::Moved { kind, from, to, .. } => {
                collection(from)?;
                collection(to)?;
                if self.may_change(actor, *from, *kind) && self.may_change(actor, *to, *kind) {
                    Ok(())
                } else {
                    Err(Error::NotAllowed)
                }
            }
        }
    }

    /// A person's name: given, and nobody else's.
    fn check_person_name(&self, name: &str, id: Uuid) -> Result<()> {
        let name = name.trim().to_lowercase();
        if name.is_empty() {
            return Err(Error::NameMissing);
        }
        if self
            .people
            .iter()
            .any(|p| p.id != id && p.name.trim().to_lowercase() == name)
        {
            return Err(Error::NameTaken);
        }
        Ok(())
    }

    /// A role an admin makes: a name no other role has, built-in or made, and one that reads
    /// without chemistry logs firings and changes and manages nothing else, since a manager gives
    /// others the collection's key, so must hold it.
    fn check_role(&self, role: &CustomRole) -> Result<()> {
        let name = role.name.trim().to_lowercase();
        if name.is_empty() {
            return Err(Error::NameMissing);
        }
        if BUILT_IN_NAMES.contains(&name.as_str())
            || self
                .roles
                .iter()
                .any(|r| r.id != role.id && r.name.trim().to_lowercase() == name)
        {
            return Err(Error::RoleNameTaken);
        }
        if !role.may.chemistry && (role.may.manage || role.changes.iter().any(|&kind| kind != Kind::Firing)) {
            return Err(Error::ChemistryNeeded);
        }
        Ok(())
    }
}

fn parse_id(text: &str) -> Result<Uuid> {
    Uuid::parse_str(text).map_err(|_| Error::Corrupt(format!("bad id {text}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SealedBox;

    /// A team with Ana, its admin; Cleo, who manages Shared with a role an admin made; Ben, a
    /// chemist there; and Dee, who has nothing yet. Nothing in it is a key.
    struct Team {
        directory: Directory,
        ana: Uuid,
        ben: Uuid,
        cleo: Uuid,
        dee: Uuid,
        shared: Uuid,
        private: Uuid,
        lead: Uuid,
    }

    fn team() -> Team {
        let [ana, ben, cleo, dee, shared, private, lead] = [(); 7].map(|_| Uuid::new_v4());
        let member = |id, name: &str, admin| Member {
            id,
            name: name.into(),
            admin,
        };
        let granted = |person, collection, role| Granted {
            person,
            collection,
            role,
            epoch: 1,
        };
        Team {
            directory: Directory {
                people: vec![
                    member(ana, "Ana", true),
                    member(ben, "Ben", false),
                    member(cleo, "Cleo", false),
                    member(dee, "Dee", false),
                ],
                collections: vec![
                    Shelf {
                        id: shared,
                        owner: None,
                        epoch: 1,
                    },
                    Shelf {
                        id: private,
                        owner: Some(ben),
                        epoch: 1,
                    },
                ],
                grants: vec![
                    granted(ben, shared, Role::Chemist),
                    granted(cleo, shared, Role::Custom(lead)),
                    granted(ben, private, Role::Formulator),
                ],
                roles: vec![CustomRole {
                    id: lead,
                    name: "Studio lead".into(),
                    changes: vec![Kind::Recipe],
                    may: Capabilities {
                        manage: true,
                        ..Capabilities::BUILT_IN
                    },
                }],
                ..Directory::default()
            },
            ana,
            ben,
            cleo,
            dee,
            shared,
            private,
            lead,
        }
    }

    fn grant(person: Uuid, collection: Uuid, role: Role, epoch: i64) -> Body {
        Body::GrantSet {
            person,
            collection,
            role,
            epoch,
            sealed: SealedBox {
                enc: Vec::new(),
                ciphertext: Vec::new(),
            },
        }
    }

    #[test]
    fn who_may_change_and_manage_comes_from_metadata_alone() {
        let t = team();
        let d = &t.directory;
        assert!(d.is_team());
        assert!(d.may_change(t.ana, t.shared, Kind::Batch));
        assert!(!d.may_change(t.ben, t.shared, Kind::Recipe));
        assert!(d.may_change(t.cleo, t.shared, Kind::Recipe));
        assert!(!d.may_change(t.cleo, t.shared, Kind::Material));
        assert!(!d.may_change(t.dee, t.shared, Kind::Recipe));
        assert!(!d.may_change(t.ana, Uuid::new_v4(), Kind::Recipe));
        assert!(d.may_manage(t.cleo, t.shared) && d.may_manage(t.ana, t.private));
        assert!(!d.may_manage(t.ben, t.shared) && !d.may_manage(t.ben, t.private));
        assert_eq!(d.held(Role::Operator), Held::Batch);
        assert_eq!(d.held(Role::Custom(t.lead)), Held::Collection);
    }

    #[test]
    fn a_manager_gives_lesser_roles_to_others_and_seals_again_after_a_new_epoch() {
        let t = team();
        let d = &t.directory;
        assert!(d.check(t.cleo, &grant(t.dee, t.shared, Role::Tester, 1)).is_ok());
        assert!(d.check(t.cleo, &grant(t.ben, t.shared, Role::Operator, 1)).is_ok());
        for refused in [
            grant(t.dee, t.shared, Role::Admin, 1),
            grant(t.dee, t.shared, Role::Custom(t.lead), 1),
            grant(t.ana, t.shared, Role::Chemist, 1),
            grant(t.cleo, t.shared, Role::Chemist, 1),
        ] {
            assert!(matches!(d.check(t.cleo, &refused), Err(Error::ManagersOnlyLower)));
        }
        assert!(matches!(
            d.check(t.cleo, &grant(t.dee, t.private, Role::Chemist, 1)),
            Err(Error::NotAllowed)
        ));
        assert!(matches!(
            d.check(t.cleo, &grant(t.dee, t.shared, Role::Custom(Uuid::new_v4()), 1)),
            Err(Error::NoSuchRole)
        ));
        assert!(matches!(
            d.check(t.ana, &grant(t.dee, t.shared, Role::Chemist, 2)),
            Err(Error::Corrupt(_))
        ));
        let removing = |person| Body::GrantRemoved {
            person,
            collection: t.shared,
        };
        assert!(d.check(t.cleo, &removing(t.ben)).is_ok());
        assert!(matches!(
            d.check(t.cleo, &removing(t.cleo)),
            Err(Error::ManagersOnlyLower)
        ));
        assert!(matches!(d.check(t.ben, &removing(t.cleo)), Err(Error::NotAllowed)));

        // After Cleo starts a new epoch, she seals Ben's and her own grants again as they were, and
        // nothing more.
        let epoch = Body::KeyEpoch {
            collection: t.shared,
            epoch: 2,
            previous: Vec::new(),
            previous_batch: Vec::new(),
            previous_summary: Vec::new(),
        };
        assert!(d.check(t.cleo, &epoch).is_ok());
        assert!(d.check(t.ben, &epoch).is_err());
        let mut after = d.clone();
        after.collections[0].epoch = 2;
        assert!(after.check(t.cleo, &grant(t.ben, t.shared, Role::Chemist, 2)).is_ok());
        assert!(
            after
                .check(t.cleo, &grant(t.cleo, t.shared, Role::Custom(t.lead), 2))
                .is_ok()
        );
        assert!(matches!(
            after.check(t.cleo, &grant(t.cleo, t.shared, Role::Admin, 2)),
            Err(Error::ManagersOnlyLower)
        ));
    }

    #[test]
    fn only_an_admin_changes_people_and_roles() {
        let t = team();
        let d = &t.directory;
        let added = |name: &str| Body::PersonAdded {
            person: Uuid::new_v4(),
            name: name.into(),
            public_key: Vec::new(),
        };
        assert!(d.check(t.ana, &added("Eve")).is_ok());
        assert!(matches!(d.check(t.ana, &added(" ben ")), Err(Error::NameTaken)));
        assert!(matches!(d.check(t.ana, &added("  ")), Err(Error::NameMissing)));
        assert!(matches!(d.check(t.cleo, &added("Eve")), Err(Error::NotAllowed)));
        assert!(matches!(d.check(Uuid::new_v4(), &added("Eve")), Err(Error::NotAllowed)));

        let removed = |person| Body::PersonRemoved { person };
        assert!(d.check(t.ana, &removed(t.ben)).is_ok());
        assert!(matches!(d.check(t.ana, &removed(t.ana)), Err(Error::NotAllowed)));
        let mut two_admins = d.clone();
        two_admins.people[1].admin = true;
        assert!(matches!(
            two_admins.check(t.ana, &removed(t.ben)),
            Err(Error::RemovingAdmin)
        ));
        let taken = |person| Body::AdminTaken {
            person,
            organization_key: Vec::new(),
        };
        assert!(two_admins.check(t.ana, &taken(t.ben)).is_ok());
        assert!(matches!(d.check(t.ana, &taken(t.ben)), Err(Error::NotAnAdmin)));
        assert!(matches!(d.check(t.ana, &taken(t.ana)), Err(Error::NotAllowed)));

        let role = |name: &str, may: Capabilities, changes: Vec<Kind>| Body::RoleCreated {
            role: CustomRole {
                id: Uuid::new_v4(),
                name: name.into(),
                changes,
                may,
            },
        };
        assert!(
            d.check(t.ana, &role("Costing", Capabilities::BUILT_IN, vec![Kind::Prices]))
                .is_ok()
        );
        assert!(matches!(
            d.check(t.cleo, &role("Costing", Capabilities::BUILT_IN, vec![])),
            Err(Error::NotAllowed)
        ));
        for taken_name in ["studio LEAD", "Batch operator"] {
            assert!(matches!(
                d.check(t.ana, &role(taken_name, Capabilities::BUILT_IN, vec![])),
                Err(Error::RoleNameTaken)
            ));
        }
        let reader = Capabilities {
            chemistry: false,
            ..Capabilities::BUILT_IN
        };
        assert!(d.check(t.ana, &role("Sales", reader, vec![Kind::Firing])).is_ok());
        assert!(matches!(
            d.check(t.ana, &role("Sales", reader, vec![Kind::Recipe])),
            Err(Error::ChemistryNeeded)
        ));
        assert!(matches!(
            d.check(t.ana, &Body::RoleDeleted { role: t.lead }),
            Err(Error::RoleInUse)
        ));
    }

    #[test]
    fn a_one_person_vault_has_one_person_to_decide() {
        let (me, collection) = (Uuid::new_v4(), Uuid::new_v4());
        let empty = Directory::default();
        let added = |person| Body::PersonAdded {
            person,
            name: String::new(),
            public_key: Vec::new(),
        };
        assert!(empty.check(me, &added(me)).is_ok());
        assert!(empty.check(me, &added(Uuid::new_v4())).is_err());

        let alone = Directory {
            people: vec![Member {
                id: me,
                name: String::new(),
                admin: false,
            }],
            collections: vec![Shelf {
                id: collection,
                owner: None,
                epoch: 1,
            }],
            grants: vec![Granted {
                person: me,
                collection,
                role: Role::Admin,
                epoch: 1,
            }],
            ..Directory::default()
        };
        assert!(!alone.is_team());
        assert!(alone.may_change(me, collection, Kind::Material));
        assert!(matches!(alone.check(me, &added(Uuid::new_v4())), Err(Error::NotATeam)));
        let rename = Body::CollectionRenamed {
            collection,
            name: "Mine".into(),
        };
        assert!(matches!(alone.check(me, &rename), Err(Error::NotATeam)));
        let formed = |name: &str| Body::TeamFormed {
            person: me,
            name: name.into(),
            public_key: Vec::new(),
            organization_key: Vec::new(),
        };
        assert!(alone.check(me, &formed("Ana")).is_ok());
        assert!(matches!(alone.check(me, &formed(" ")), Err(Error::NameMissing)));
        let t = team();
        assert!(matches!(
            t.directory.check(t.ana, &formed("Ana")),
            Err(Error::AlreadyATeam)
        ));
    }

    #[test]
    fn roles_are_kept_as_text_and_read_back() {
        let custom = Role::Custom(Uuid::new_v4());
        for role in [
            Role::Operator,
            Role::Chemist,
            Role::Tester,
            Role::Formulator,
            Role::Admin,
            custom,
        ] {
            assert_eq!(Role::parse(&role.code()), Some(role));
            assert_eq!(
                serde_json::from_value::<Role>(serde_json::to_value(role).unwrap()).unwrap(),
                role
            );
        }
        assert_eq!(Role::parse("role:not-an-id"), None);
        assert_eq!(Role::parse("owner"), None);
    }

    #[test]
    fn a_tester_logs_firings_and_mixes_and_changes_nothing_else() {
        assert_eq!(Role::Tester.changes(Kind::Firing), Some(true));
        assert_eq!(Role::Tester.changes(Kind::Recipe), Some(false));
        assert_eq!(Role::Tester.changes(Kind::Mix), Some(true));
        assert_eq!(Role::Chemist.changes(Kind::Firing), Some(false));
        assert_eq!(Role::Chemist.changes(Kind::Mix), Some(false));
        assert_eq!(Role::Formulator.changes(Kind::Prices), Some(true));
    }

    #[test]
    fn a_batch_operator_logs_mixes_and_changes_nothing_else() {
        assert_eq!(Role::Operator.changes(Kind::Mix), Some(true));
        assert_eq!(Role::Operator.changes(Kind::Batch), Some(false));
        assert_eq!(Role::Operator.changes(Kind::Firing), Some(false));
    }
}
