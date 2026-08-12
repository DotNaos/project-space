use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::protected_file;
use crate::protocol::Observation;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub last_accepted_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Observation>,
    pub schema_version: u8,
    pub target_key: String,
}

pub fn load(path: &Path, config: &Config) -> Result<State, String> {
    let target_key = target_key(config);
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
            if state.target_key != target_key {
                return Ok(new_state(target_key));
            }
            Ok(state)
        }
        Err(_) if protected_file::is_missing(path) => Ok(new_state(target_key)),
        Err(error) => Err(error),
    }
}

fn new_state(target_key: String) -> State {
    State {
        schema_version: 1,
        target_key,
        ..State::default()
    }
}

fn target_key(config: &Config) -> String {
    format!(
        "{}:{}:{}",
        config.device_id,
        config.environment_id,
        config.host_id.as_deref().unwrap_or("none")
    )
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
            target_key: target_key(&test_config()),
        };
        save(&path, &state).unwrap();
        assert_eq!(
            load(&path, &test_config()).unwrap().last_accepted_sequence,
            7
        );
        assert!(!String::from_utf8(fs::read(path).unwrap())
            .unwrap()
            .contains("token"));
    }

    #[test]
    fn changing_the_target_resets_sequence_and_pending_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let original = test_config();
        save(
            &path,
            &State {
                last_accepted_sequence: 7,
                pending: None,
                schema_version: 1,
                target_key: target_key(&original),
            },
        )
        .unwrap();
        let mut changed = test_config();
        changed.device_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into();
        let loaded = load(&path, &changed).unwrap();
        assert_eq!(loaded.last_accepted_sequence, 0);
        assert!(loaded.pending.is_none());
        assert_eq!(loaded.target_key, target_key(&changed));
    }

    fn test_config() -> Config {
        Config {
            device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            endpoint: "http://127.0.0.1:1".into(),
            environment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            host_id: None,
            interval_seconds: 30,
            runtimes: vec![],
            schema_version: 1,
            state_path: std::path::PathBuf::from("/tmp/hostd-state-test"),
            token: "A".repeat(43),
        }
    }
}
