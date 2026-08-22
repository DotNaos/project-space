use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub architecture: String,
    pub cpu: Cpu,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<Vec<Gpu>>,
    pub memory: Memory,
    pub operating_system: String,
    pub storage: Storage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Gpu {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cpu {
    pub cores: f64,
    pub used_percent: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Memory {
    pub available_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Storage {
    pub available_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTelemetry {
    pub boundary_kind: String,
    pub cpu_percent: f64,
    pub generation: String,
    pub memory_bytes: u64,
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub device_id: String,
    pub environment_id: String,
    pub health: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub hostd_version: String,
    pub observation_id: String,
    pub observed_at: String,
    pub partial_metrics: Vec<String>,
    pub protocol_version: u8,
    pub resources: Resources,
    pub runtimes: Vec<RuntimeTelemetry>,
    pub schema_version: u8,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub message_type: String,
    pub uptime_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Accepted {
    pub accepted_sequence: u64,
    pub replayed: bool,
    pub schema_version: u8,
    pub stale_after_seconds: u64,
    #[serde(rename = "type")]
    pub message_type: String,
}
