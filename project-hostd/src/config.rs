use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::protected_file;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub device_id: String,
    pub endpoint: String,
    pub environment_id: String,
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
    #[serde(default)]
    pub runtimes: Vec<RegisteredRuntime>,
    pub schema_version: u8,
    pub state_path: PathBuf,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredRuntime {
    pub generation: String,
    pub process_group_leader_identity: String,
    pub process_group_leader_pid: u32,
    pub process_group_id: u32,
    pub workspace_id: String,
}

fn default_interval() -> u64 {
    30
}

pub fn load(path: &Path) -> Result<Config, String> {
    let bytes = protected_file::read(path, 64 * 1024, "hostd config")?;
    let mut config: Config =
        serde_json::from_slice(&bytes).map_err(|_| "hostd config is invalid".to_string())?;
    validate(&mut config)?;
    Ok(config)
}

fn validate(config: &mut Config) -> Result<(), String> {
    if config.schema_version != 1
        || !is_uuid(&config.device_id)
        || !is_uuid(&config.environment_id)
        || config.host_id.as_deref().is_some_and(|id| !is_uuid(id))
        || config.interval_seconds < 10
        || config.interval_seconds > 3600
        || config.token.len() != 43
        || !config
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || !config.state_path.is_absolute()
        || !valid_endpoint(&config.endpoint)
        || config.runtimes.len() > 128
    {
        return Err("hostd config is invalid".into());
    }
    config.endpoint = config.endpoint.trim_end_matches('/').to_string();
    for runtime in &config.runtimes {
        if !is_uuid(&runtime.workspace_id)
            || !is_uuid(&runtime.generation)
            || runtime.process_group_id == 0
            || runtime.process_group_leader_pid == 0
            || runtime.process_group_id != runtime.process_group_leader_pid
            || runtime.process_group_leader_identity.is_empty()
            || runtime.process_group_leader_identity.len() > 128
            || !runtime.process_group_leader_identity.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-')
            })
        {
            return Err("hostd runtime registration is invalid".into());
        }
    }
    config
        .runtimes
        .sort_by(|a, b| (&a.workspace_id, &a.generation).cmp(&(&b.workspace_id, &b.generation)));
    if config.runtimes.windows(2).any(|pair| {
        pair[0].workspace_id == pair[1].workspace_id && pair[0].generation == pair[1].generation
    }) {
        return Err("hostd runtime registration is duplicated".into());
    }
    Ok(())
}

fn valid_endpoint(value: &str) -> bool {
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_none()
    {
        return false;
    }
    parsed.scheme() == "https"
        || parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

pub fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && matches!(value.as_bytes()[14], b'1'..=b'8')
        && matches!(value.as_bytes()[19], b'8'..=b'9' | b'a'..=b'b' | b'A'..=b'B')
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn endpoint_rejects_public_plaintext_and_userinfo() {
        assert!(!valid_endpoint("http://example.com"));
        assert!(!valid_endpoint("https://token@example.com"));
        assert!(valid_endpoint("https://projects.example.test"));
        assert!(valid_endpoint("http://127.0.0.1:1234"));
    }

    #[cfg(unix)]
    #[test]
    fn config_rejects_broad_permissions_and_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("hostd.json");
        fs::write(&config, "{}").unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&config)
            .unwrap_err()
            .contains("must not be accessible"));
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.path().join("hostd-link.json");
        symlink(&config, &link).unwrap();
        assert!(load(&link).unwrap_err().contains("regular file"));
    }
}
