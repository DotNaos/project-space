use std::io::Read;
use std::time::Duration;

use crate::config::Config;
use crate::protocol::{Accepted, Observation};

#[derive(Debug, Eq, PartialEq)]
pub enum DeliveryError {
    Rejected,
    Resync(u64),
    StaleObservation,
    UnregisteredRuntime,
    Unavailable,
}

pub fn send(config: &Config, observation: &Observation) -> Result<Accepted, DeliveryError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .timeout_write(Duration::from_secs(10))
        .redirects(0)
        .build();
    let response = agent
        .post(&format!("{}/api/compute/hostd/telemetry", config.endpoint))
        .set("Authorization", &format!("Bearer {}", config.token))
        .set("Content-Type", "application/json")
        .send_json(observation);
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => {
            let payload: ErrorResponse =
                bounded_json(response).map_err(|_| DeliveryError::Unavailable)?;
            return match payload.error.code.as_str() {
                "stale_observation" => Err(DeliveryError::StaleObservation),
                "unregistered_runtime" => Err(DeliveryError::UnregisteredRuntime),
                "replay_conflict" | "sequence_conflict" => payload
                    .error
                    .expected_next_sequence
                    .filter(|sequence| *sequence > 0)
                    .map_or(Err(DeliveryError::Rejected), |sequence| {
                        Err(DeliveryError::Resync(sequence))
                    }),
                "authentication_failed" | "target_conflict" => Err(DeliveryError::Rejected),
                _ => Err(DeliveryError::Unavailable),
            };
        }
        Err(_) => return Err(DeliveryError::Unavailable),
    };
    if response.status() != 200 {
        return Err(DeliveryError::Unavailable);
    }
    let accepted: Accepted = bounded_json(response).map_err(|_| DeliveryError::Unavailable)?;
    if accepted.schema_version != 1
        || accepted.message_type != "hostd.accepted"
        || accepted.accepted_sequence != observation.sequence
        || accepted.stale_after_seconds < 30
    {
        return Err(DeliveryError::Unavailable);
    }
    Ok(accepted)
}

fn bounded_json<Value: serde::de::DeserializeOwned>(response: ureq::Response) -> Result<Value, ()> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(8 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > 8 * 1024 {
        return Err(());
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

#[derive(serde::Deserialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(serde::Deserialize)]
struct ErrorBody {
    code: String,
    #[serde(default, rename = "expectedNextSequence")]
    expected_next_sequence: Option<u64>,
}
