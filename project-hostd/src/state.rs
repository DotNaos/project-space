use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::protected_file;
use crate::protocol::Observation;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub last_accepted_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Observation>,
    pub schema_version: u8,
}

pub fn load(path: &Path) -> Result<State, String> {
    match protected_file::read(path, 256 * 1024, "hostd state") {
        Ok(bytes) => {
            let state: State =
                serde_json::from_slice(&bytes).map_err(|_| "hostd state is invalid".to_string())?;
            if state.schema_version != 1
                || state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.sequence != state.last_accepted_sequence + 1)
            {
                return Err("hostd state is invalid".into());
            }
            Ok(state)
        }
        Err(_) if protected_file::is_missing(path) => Ok(State {
            schema_version: 1,
            ..State::default()
        }),
        Err(error) => Err(error),
    }
}

pub fn save(path: &Path, state: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|_| "cannot encode hostd state".to_string())?;
    protected_file::write_atomic(path, &bytes, "hostd state")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn state_is_restart_safe_and_contains_no_credential() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let state = State {
            last_accepted_sequence: 7,
            pending: None,
            schema_version: 1,
        };
        save(&path, &state).unwrap();
        assert_eq!(load(&path).unwrap().last_accepted_sequence, 7);
        assert!(!String::from_utf8(fs::read(path).unwrap())
            .unwrap()
            .contains("token"));
    }
}
