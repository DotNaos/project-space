use std::io::Read;
use std::time::Duration;

use crate::config::Config;
use crate::protocol::{Accepted, Observation};

#[derive(Debug, Eq, PartialEq)]
pub enum DeliveryError {
    StaleObservation,
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
                serde_json::from_reader(response.into_reader().take(8 * 1024))
                    .map_err(|_| DeliveryError::Unavailable)?;
            return if payload.error.code == "stale_observation" {
                Err(DeliveryError::StaleObservation)
            } else {
                Err(DeliveryError::Unavailable)
            };
        }
        Err(_) => return Err(DeliveryError::Unavailable),
    };
    if response.status() != 200 {
        return Err(DeliveryError::Unavailable);
    }
    let accepted: Accepted = serde_json::from_reader(response.into_reader().take(8 * 1024))
        .map_err(|_| DeliveryError::Unavailable)?;
    if accepted.schema_version != 1
        || accepted.message_type != "hostd.accepted"
        || accepted.accepted_sequence != observation.sequence
        || accepted.stale_after_seconds < 30
    {
        return Err(DeliveryError::Unavailable);
    }
    Ok(accepted)
}

#[derive(serde::Deserialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(serde::Deserialize)]
struct ErrorBody {
    code: String,
}
