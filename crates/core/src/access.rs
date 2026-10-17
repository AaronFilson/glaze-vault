//! What each person may do in a collection (docs/adr/0004-roles-and-collections.md, 0012). Every
//! command is checked here, in the core; the UI only hides what would be refused.

use serde::{Deserialize, Serialize};

/// A fixed set of capabilities, given to a person on a collection. A one-person vault's only
/// person is an admin of its only collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Reads batch sheets, and nothing else: no recipes, materials or chemistry. Their grant
    /// holds only the collection's batch key (crate::vault::batch_key).
    Operator,
    /// Reads recipes, materials and their chemistry.
    Chemist,
    /// Also makes, changes, deletes and erases them.
    Formulator,
    /// Everything, on every collection, with people, collections and backups.
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Operator => "operator",
            Role::Chemist => "chemist",
            Role::Formulator => "formulator",
            Role::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Option<Role> {
        match text {
            "operator" => Some(Role::Operator),
            "chemist" => Some(Role::Chemist),
            "formulator" => Some(Role::Formulator),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }

    /// Making, changing, deleting and erasing records.
    pub fn can_edit(self) -> bool {
        matches!(self, Role::Formulator | Role::Admin)
    }
}
