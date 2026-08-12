mod client;
mod config;
mod metrics;
mod process_identity;
mod protected_file;
mod protocol;
mod state;

use std::path::PathBuf;
use std::time::Duration;

fn main() {
    if let Err(error) = run() {
        eprintln!("project-hostd: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let config_path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "usage: project-hostd <config-path> [--once]".to_string())?;
    let once = match args.next() {
        None => false,
        Some(value) if value == "--once" => true,
        Some(_) => return Err("usage: project-hostd <config-path> [--once]".into()),
    };
    if args.next().is_some() {
        return Err("usage: project-hostd <config-path> [--once]".into());
    }
    loop {
        let config = config::load(&config_path)?;
        if let Err(error) = cycle(&config) {
            if once {
                return Err(error);
            }
            eprintln!("project-hostd: telemetry cycle failed; retrying");
        } else if once {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(config.interval_seconds));
    }
}

fn cycle(config: &config::Config) -> Result<(), String> {
    let mut state = state::load(&config.state_path, config)?;
    let mut observation = match state.pending.clone() {
        Some(pending) => pending,
        None => {
            let observation = metrics::collect(config, state.last_accepted_sequence + 1)?;
            state.pending = Some(observation.clone());
            state::save(&config.state_path, &state)?;
            observation
        }
    };
    let accepted = match client::send(config, &observation) {
        Ok(accepted) => accepted,
        Err(client::DeliveryError::StaleObservation) => {
            state.pending = None;
            state::save(&config.state_path, &state)?;
            return Err("stale telemetry was discarded before retry".into());
        }
        Err(client::DeliveryError::UnregisteredRuntime) => {
            observation.runtimes.clear();
            if !observation
                .partial_metrics
                .iter()
                .any(|metric| metric == "runtime")
            {
                observation.partial_metrics.push("runtime".into());
            }
            observation.health = "degraded".into();
            state.pending = Some(observation);
            state::save(&config.state_path, &state)?;
            return Err("hostd runtime attribution was rejected and removed before retry".into());
        }
        Err(client::DeliveryError::Rejected) => {
            state.pending = None;
            state::save(&config.state_path, &state)?;
            return Err("hostd telemetry was rejected; fresh evidence will be collected".into());
        }
        Err(client::DeliveryError::Resync(expected_next_sequence)) => {
            state.last_accepted_sequence = expected_next_sequence - 1;
            state.pending = None;
            state::save(&config.state_path, &state)?;
            return Err(
                "hostd telemetry sequence was resynchronized; fresh evidence will be collected"
                    .into(),
            );
        }
        Err(client::DeliveryError::Unavailable) => {
            return Err("hostd telemetry delivery failed".into());
        }
    };
    let _ = accepted.replayed;
    state.last_accepted_sequence = observation.sequence;
    state.pending = None;
    state::save(&config.state_path, &state)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn disconnected_delivery_retries_the_exact_pending_observation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut first = listener.accept().unwrap().0;
            let first_body = read_body(&mut first);
            drop(first);

            let mut second = listener.accept().unwrap().0;
            let second_body = read_body(&mut second);
            assert_eq!(first_body, second_body);
            let observation: serde_json::Value = serde_json::from_slice(&second_body).unwrap();
            let sequence = observation["sequence"].as_u64().unwrap();
            let body = serde_json::json!({
                "acceptedSequence": sequence,
                "replayed": false,
                "schemaVersion": 1,
                "staleAfterSeconds": 90,
                "type": "hostd.accepted"
            })
            .to_string();
            write!(second, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let config = config::Config {
            device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            endpoint,
            environment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            host_id: None,
            interval_seconds: 30,
            runtimes: vec![],
            schema_version: 1,
            state_path: root.path().join("state/hostd.json"),
            token: "A".repeat(43),
        };
        assert!(cycle(&config).is_err());
        let pending = state::load(&config.state_path, &config)
            .unwrap()
            .pending
            .unwrap();
        cycle(&config).unwrap();
        let completed = state::load(&config.state_path, &config).unwrap();
        assert_eq!(completed.last_accepted_sequence, pending.sequence);
        assert!(completed.pending.is_none());
        server.join().unwrap();
    }

    #[test]
    fn server_sequence_is_reconciled_before_collecting_fresh_evidence() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut first = listener.accept().unwrap().0;
            let first_body = read_body(&mut first);
            let first_observation: serde_json::Value = serde_json::from_slice(&first_body).unwrap();
            assert_eq!(first_observation["sequence"], 1);
            let conflict = serde_json::json!({
                "error": {
                    "code": "sequence_conflict",
                    "expectedNextSequence": 8,
                    "message": "project-hostd sequence is not contiguous."
                }
            })
            .to_string();
            write!(first, "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", conflict.len(), conflict).unwrap();

            let mut second = listener.accept().unwrap().0;
            let second_body = read_body(&mut second);
            let second_observation: serde_json::Value =
                serde_json::from_slice(&second_body).unwrap();
            assert_eq!(second_observation["sequence"], 8);
            let accepted = serde_json::json!({
                "acceptedSequence": 8,
                "replayed": false,
                "schemaVersion": 1,
                "staleAfterSeconds": 90,
                "type": "hostd.accepted"
            })
            .to_string();
            write!(second, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", accepted.len(), accepted).unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let config = config::Config {
            device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            endpoint,
            environment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            host_id: None,
            interval_seconds: 30,
            runtimes: vec![],
            schema_version: 1,
            state_path: root.path().join("state/hostd.json"),
            token: "A".repeat(43),
        };
        assert!(cycle(&config).is_err());
        let reconciled = state::load(&config.state_path, &config).unwrap();
        assert_eq!(reconciled.last_accepted_sequence, 7);
        assert!(reconciled.pending.is_none());
        cycle(&config).unwrap();
        assert_eq!(
            state::load(&config.state_path, &config)
                .unwrap()
                .last_accepted_sequence,
            8
        );
        server.join().unwrap();
    }

    fn read_body(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")?
                            .parse::<usize>()
                            .ok()
                    })
                    .unwrap();
                let body_start = header_end + 4;
                if bytes.len() >= body_start + length {
                    return bytes[body_start..body_start + length].to_vec();
                }
            }
        }
        panic!("incomplete hostd request")
    }
}
