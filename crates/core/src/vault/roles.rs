//! Roles admins make (docs/adr/0004-roles-and-collections.md): a name, the kinds of record a
//! person with it may make and change, and what else they may do: export, print, read recipes'
//! chemistry, and manage the people on its collections. One that reads chemistry holds the
//! collection's key, so changing what it may change needs no new keys; one that reads without it
//! holds the summary key only (summaries.rs), so changing that gives its collections new keys.
//! Reading batch sheets alone stays the batch operator's, whose grant holds the batch key.

use super::events::{self, Body};
use super::{Held, Kind, Vault};
use crate::access::Role;
use crate::error::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A role an admin made.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRole {
    pub id: Uuid,
    pub name: String,
    /// The kinds of record it may make, change, delete and erase.
    pub changes: Vec<Kind>,
    #[serde(flatten)]
    pub may: Capabilities,
}

/// What a role may do besides changing records. Export and print are kept to by the page and the
/// command that writes an export: whoever can read a recipe can still copy it from the screen.
/// Reading without chemistry and managing are kept to by keys and by the core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub export: bool,
    pub print: bool,
    /// Reads recipes' lines and notes, materials, limits, prices and batch sheets. Without it,
    /// a role reads recipes' names and details, and firings with their photos, and may change
    /// only firings.
    pub chemistry: bool,
    /// Gives and takes away roles on its collections, other than an admin's or a manager's.
    pub manage: bool,
}

impl Capabilities {
    /// What the built-in roles may do, as before roles had capabilities.
    pub const BUILT_IN: Capabilities = Capabilities {
        export: true,
        print: true,
        chemistry: true,
        manage: false,
    };
    pub(crate) const NONE: Capabilities = Capabilities {
        export: false,
        print: false,
        chemistry: false,
        manage: false,
    };

    pub(crate) fn code(self) -> String {
        [
            (self.export, "export"),
            (self.print, "print"),
            (self.chemistry, "chemistry"),
            (self.manage, "manage"),
        ]
        .into_iter()
        .filter_map(|(may, name)| may.then_some(name))
        .collect::<Vec<_>>()
        .join(",")
    }

    pub(crate) fn parse(text: &str) -> Capabilities {
        let has = |name: &str| text.split(',').any(|part| part == name);
        Capabilities {
            export: has("export"),
            print: has("print"),
            chemistry: has("chemistry"),
            manage: has("manage"),
        }
    }
}

impl Vault {
    /// Whether a role lets this person make and change records of a kind.
    pub(super) fn may_change(&self, role: Role, kind: Kind) -> bool {
        self.directory.changes(role, kind)
    }

    /// What a role may do besides changing records.
    pub(super) fn capabilities(&self, role: Role) -> Capabilities {
        self.directory.capabilities(role)
    }

    /// Which key a grant of a role holds.
    pub(super) fn held(&self, role: Role) -> Held {
        self.directory.held(role)
    }

    /// The roles admins have made, for anyone signed in to a team's vault: what their collections
    /// call each other's roles.
    pub fn custom_roles(&self) -> Vec<CustomRole> {
        self.directory.roles.clone()
    }

    /// Makes a role, for an admin to give people.
    pub fn create_role(&mut self, name: &str, changes: &[Kind], may: Capabilities) -> Result<CustomRole> {
        let role = CustomRole {
            id: Uuid::new_v4(),
            name: name.trim().to_owned(),
            changes: tidy(changes),
            may,
        };
        let tx = self.conn.unchecked_transaction()?;
        events::record(&tx, &self.signer, Body::RoleCreated { role: role.clone() })?;
        if !may.chemistry {
            self.ready_for(Held::Summary)?;
        }
        tx.commit()?;
        self.load_collections()?;
        Ok(role)
    }

    /// Renames a role, or changes what it may do, for everyone who has it. Reading without
    /// chemistry where it read with it gives each collection it is given on a new key, since its
    /// people held the old one; the other way, their grants are sealed again with the
    /// collection's key.
    pub fn change_role(&mut self, id: Uuid, name: &str, changes: &[Kind], may: Capabilities) -> Result<()> {
        let role = CustomRole {
            id,
            name: name.trim().to_owned(),
            changes: tidy(changes),
            may,
        };
        let before = self.held(Role::Custom(id));
        let tx = self.conn.unchecked_transaction()?;
        events::record(&tx, &self.signer, Body::RoleChanged { role })?;
        if !may.chemistry {
            self.ready_for(Held::Summary)?;
        }
        self.regrant(&tx, Role::Custom(id), before)?;
        tx.commit()?;
        self.load_collections()
    }

    /// Deletes a role nobody has.
    pub fn delete_role(&mut self, id: Uuid) -> Result<()> {
        events::record(&self.conn, &self.signer, Body::RoleDeleted { role: id })?;
        self.load_collections()
    }
}

/// Each kind once, in a fixed order.
fn tidy(changes: &[Kind]) -> Vec<Kind> {
    Kind::ALL.into_iter().filter(|kind| changes.contains(kind)).collect()
}

/// How a role's kinds are kept: comma-separated.
pub(crate) fn joined(changes: &[Kind]) -> String {
    changes.iter().map(|kind| kind.as_str()).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
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
        assert_eq!(collection.changes, [Kind::Firing, Kind::Mix]);
    }

    #[test]
    fn an_admin_makes_a_role_and_changes_what_it_may_change() {
        let (dir, mut ana, shared) = team();
        let costing = ana
            .create_role("  Costing ", &[Kind::Prices, Kind::Prices], Capabilities::BUILT_IN)
            .unwrap();
        assert_eq!(
            (costing.name.as_str(), costing.changes.as_slice()),
            ("Costing", &[Kind::Prices][..])
        );
        assert!(matches!(
            ana.create_role("costing", &[], Capabilities::BUILT_IN),
            Err(Error::RoleNameTaken)
        ));
        assert!(matches!(
            ana.create_role("Chemist", &[], Capabilities::BUILT_IN),
            Err(Error::RoleNameTaken)
        ));
        assert!(matches!(
            ana.create_role(" ", &[], Capabilities::BUILT_IN),
            Err(Error::NameMissing)
        ));

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
        assert!(matches!(
            as_ben.create_role("Mine", &[], Capabilities::BUILT_IN),
            Err(Error::NotAllowed)
        ));
        drop(as_ben);

        // Changed for everyone who has it, from the next sign-in.
        ana.change_role(
            costing.id,
            "Costing and recipes",
            &[Kind::Prices, Kind::Recipe],
            Capabilities::BUILT_IN,
        )
        .unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        as_ben
            .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" }))
            .unwrap();
        assert_eq!(as_ben.custom_roles()[0].name, "Costing and recipes");
        drop(as_ben);
        ana.change_role(costing.id, "Costing", &[], Capabilities::BUILT_IN)
            .unwrap();
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

    #[test]
    fn a_manager_gives_and_takes_away_lesser_roles_on_their_collections() {
        let (dir, mut ana, shared) = team();
        let production = ana.create_collection("Production").unwrap().id;
        let lead = ana
            .create_role(
                "Studio lead",
                &[Kind::Recipe],
                Capabilities {
                    manage: true,
                    ..Capabilities::BUILT_IN
                },
            )
            .unwrap();
        let cleo = ana
            .add_person("Cleo", ONE_TIME, &[(shared, Role::Custom(lead.id))])
            .unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        let mut as_cleo = Vault::unlock_as(dir.path(), Some(cleo.id), ONE_TIME).unwrap();
        as_cleo.set_own_password("cleos own password").unwrap();
        let ana_id = as_cleo
            .people()
            .unwrap()
            .into_iter()
            .find(|p| p.name == "Ana")
            .unwrap()
            .id;

        as_cleo.set_role(ben.id, shared, Some(Role::Chemist)).unwrap();
        for refused in [
            as_cleo.set_role(ben.id, shared, Some(Role::Admin)),
            as_cleo.set_role(ben.id, shared, Some(Role::Custom(lead.id))),
            as_cleo.set_role(ana_id, shared, Some(Role::Chemist)),
            as_cleo.set_role(cleo.id, shared, None),
        ] {
            assert!(matches!(refused, Err(Error::ManagersOnlyLower)), "{refused:?}");
        }
        // Not a collection Cleo manages, or can open.
        assert!(as_cleo.set_role(ben.id, production, Some(Role::Chemist)).is_err());
        assert!(as_cleo.grants().unwrap().iter().all(|g| g.collection == shared));
        assert!(
            as_cleo
                .collections()
                .iter()
                .find(|c| c.id == shared)
                .unwrap()
                .may
                .manage
        );
        as_cleo.rename_collection(shared, "Studio").unwrap();

        // Taking Ben's role away gives the collection a new key, as when an admin does.
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).map(|mut v| {
            v.set_own_password(BENS).unwrap();
            v
        });
        let kept = as_ben.unwrap().readable(&shared).unwrap().key.clone();
        as_cleo.set_role(ben.id, shared, None).unwrap();
        assert_ne!(*as_cleo.readable(&shared).unwrap().key, *kept);
        drop(as_cleo);
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(as_ben.collections().iter().all(|c| c.id != shared));
        drop(as_ben);
        // Ana, an admin, still opens it.
        ana.load_collections().unwrap();
        assert_eq!(ana.readable(&shared).unwrap().name, "Studio");
    }
}
