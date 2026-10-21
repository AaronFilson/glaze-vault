//! What each person may do in a collection (docs/adr/0004-roles-and-collections.md, 0012). Every
//! command is checked here, in the core; the UI only hides what would be refused.

use crate::vault::Kind;
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
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.code())
    }
}

impl<'de> Deserialize<'de> for Role {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Role::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("unknown role {text}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
