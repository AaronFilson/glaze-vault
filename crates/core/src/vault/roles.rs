//! Roles admins make (docs/adr/0004-roles-and-collections.md): a name and the kinds of record a
//! person with it may make and change. Each reads everything in its collections, as a chemist
//! does, and its grant holds the collection's key, so changing what a role may change needs no
//! new keys. Reading batch sheets alone stays the batch operator's, whose grant holds another key.

use super::{Kind, Vault, now_ms, parse_id};
use crate::access::Role;
use crate::error::{Error, Result};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

/// A role an admin made.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRole {
    pub id: Uuid,
    pub name: String,
    /// The kinds of record it may make, change, delete and erase.
    pub changes: Vec<Kind>,
}

/// The built-in roles' names, which a role an admin makes cannot take.
const BUILT_IN_NAMES: [&str; 6] = ["batch operator", "operator", "chemist", "tester", "formulator", "admin"];

impl Vault {
    /// Whether a role lets this person make and change records of a kind.
    pub(super) fn may_change(&self, role: Role, kind: Kind) -> bool {
        match (role.changes(kind), role) {
            (Some(may), _) => may,
            (None, Role::Custom(id)) => self.roles.iter().any(|r| r.id == id && r.changes.contains(&kind)),
            (None, _) => false,
        }
    }

    pub(super) fn load_roles(&mut self) -> Result<()> {
        let mut statement = self
            .conn
            .prepare("SELECT id, name, changes FROM roles ORDER BY created_at")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        self.roles = rows
            .into_iter()
            .map(|(id, name, changes)| {
                Ok(CustomRole {
                    id: parse_id(&id)?,
                    name,
                    changes: changes.split(',').filter_map(Kind::parse).collect(),
                })
            })
            .collect::<Result<_>>()?;
        Ok(())
    }

    /// The roles admins have made, for anyone signed in to a team's vault: what their collections
    /// call each other's roles.
    pub fn custom_roles(&self) -> Vec<CustomRole> {
        self.roles.clone()
    }

    /// Makes a role, for an admin to give people.
    pub fn create_role(&mut self, name: &str, changes: &[Kind]) -> Result<CustomRole> {
        self.admin()?;
        let name = self.role_name(name, None)?;
        let role = CustomRole {
            id: Uuid::new_v4(),
            name,
            changes: tidy(changes),
        };
        self.conn.execute(
            "INSERT INTO roles (id, name, changes, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![role.id.to_string(), role.name, joined(&role.changes), now_ms()],
        )?;
        self.load_roles()?;
        Ok(role)
    }

    /// Renames a role, or changes what it may change, for everyone who has it.
    pub fn change_role(&mut self, id: Uuid, name: &str, changes: &[Kind]) -> Result<()> {
        self.admin()?;
        let name = self.role_name(name, Some(id))?;
        let changed = self.conn.execute(
            "UPDATE roles SET name = ?1, changes = ?2 WHERE id = ?3",
            params![name, joined(&tidy(changes)), id.to_string()],
        )?;
        if changed == 0 {
            return Err(Error::NoSuchRole);
        }
        self.load_roles()
    }

    /// Deletes a role nobody has.
    pub fn delete_role(&mut self, id: Uuid) -> Result<()> {
        self.admin()?;
        let used: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM grants WHERE role = ?1 LIMIT 1",
                params![Role::Custom(id).code()],
                |row| row.get(0),
            )
            .optional()?;
        if used.is_some() {
            return Err(Error::RoleInUse);
        }
        if self
            .conn
            .execute("DELETE FROM roles WHERE id = ?1", params![id.to_string()])?
            == 0
        {
            return Err(Error::NoSuchRole);
        }
        self.load_roles()
    }

    /// A role about to be given: a custom one must be in this vault.
    pub(super) fn known_role(&self, role: Role) -> Result<()> {
        match role {
            Role::Custom(id) if !self.roles.iter().any(|r| r.id == id) => Err(Error::NoSuchRole),
            _ => Ok(()),
        }
    }

    fn role_name(&self, name: &str, except: Option<Uuid>) -> Result<String> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::NameMissing);
        }
        let lower = name.to_lowercase();
        if BUILT_IN_NAMES.contains(&lower.as_str())
            || self
                .roles
                .iter()
                .any(|r| Some(r.id) != except && r.name.to_lowercase() == lower)
        {
            return Err(Error::RoleNameTaken);
        }
        Ok(name.to_owned())
    }
}

/// Each kind once, in a fixed order.
fn tidy(changes: &[Kind]) -> Vec<Kind> {
    Kind::ALL.into_iter().filter(|kind| changes.contains(kind)).collect()
}

fn joined(changes: &[Kind]) -> String {
    changes.iter().map(|kind| kind.as_str()).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";
    const BENS: &str = "bens own password";

    fn team() -> (tempfile::TempDir, Vault, Uuid) {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        (dir, ana, shared)
    }

    #[test]
    fn a_tester_logs_firings_and_reads_the_rest() {
        let (dir, mut ana, shared) = team();
        let recipe = ana.save_in(Kind::Recipe, shared, &json!({ "name": "Shino" })).unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Tester)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        let firing = as_ben
            .save_in(Kind::Firing, shared, &json!({ "recipe": recipe.record_id }))
            .unwrap();
        as_ben
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        assert!(matches!(
            as_ben.save(Kind::Recipe, Some(recipe.revision_id), &json!({ "name": "Mine now" })),
            Err(Error::NotAllowed)
        ));
        assert_eq!(as_ben.heads(Kind::Recipe).unwrap().len(), 1);
        let collection = as_ben.collections().into_iter().find(|c| c.id == shared).unwrap();
        assert_eq!(collection.changes, [Kind::Firing]);
    }

    #[test]
    fn an_admin_makes_a_role_and_changes_what_it_may_change() {
        let (dir, mut ana, shared) = team();
        let costing = ana.create_role("  Costing ", &[Kind::Prices, Kind::Prices]).unwrap();
        assert_eq!(
            (costing.name.as_str(), costing.changes.as_slice()),
            ("Costing", &[Kind::Prices][..])
        );
        assert!(matches!(ana.create_role("costing", &[]), Err(Error::RoleNameTaken)));
        assert!(matches!(ana.create_role("Chemist", &[]), Err(Error::RoleNameTaken)));
        assert!(matches!(ana.create_role(" ", &[]), Err(Error::NameMissing)));

        let ben = ana
            .add_person("Ben", ONE_TIME, &[(shared, Role::Custom(costing.id))])
            .unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        let prices = as_ben.save_in(Kind::Prices, shared, &json!({ "prices": [] })).unwrap();
        assert!(matches!(
            as_ben.save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" })),
            Err(Error::NotAllowed)
        ));
        assert!(matches!(as_ben.create_role("Mine", &[]), Err(Error::NotAllowed)));
        drop(as_ben);

        // Changed for everyone who has it, from the next sign-in.
        ana.change_role(costing.id, "Costing and recipes", &[Kind::Prices, Kind::Recipe])
            .unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        as_ben
            .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" }))
            .unwrap();
        assert_eq!(as_ben.custom_roles()[0].name, "Costing and recipes");
        drop(as_ben);
        ana.change_role(costing.id, "Costing", &[]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(matches!(
            as_ben.save(Kind::Prices, Some(prices.revision_id), &json!({ "prices": [1] })),
            Err(Error::NotAllowed)
        ));
        drop(as_ben);

        assert!(matches!(ana.delete_role(costing.id), Err(Error::RoleInUse)));
        ana.set_role(ben.id, shared, Some(Role::Chemist)).unwrap();
        ana.delete_role(costing.id).unwrap();
        assert!(matches!(ana.delete_role(costing.id), Err(Error::NoSuchRole)));
        assert!(matches!(
            ana.set_role(ben.id, shared, Some(Role::Custom(costing.id))),
            Err(Error::NoSuchRole)
        ));
    }
}
