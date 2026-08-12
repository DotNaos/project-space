use sysinfo::{Disks, System};

use crate::config::{Config, RegisteredRuntime};
use crate::protocol::{Cpu, Memory, Observation, Resources, RuntimeTelemetry, Storage};

pub fn collect(config: &Config, sequence: u64) -> Result<Observation, String> {
    let mut system = System::new_all();
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_all();
    let disks = Disks::new_with_refreshed_list();
    let (total_storage, available_storage) = largest_local_storage(&disks)
        .ok_or_else(|| "required storage metrics are unavailable".to_string())?;
    if system.cpus().is_empty() || system.total_memory() == 0 || total_storage == 0 {
        return Err("required host metrics are unavailable".into());
    }
    let mut partial = Vec::new();
    let runtimes = config
        .runtimes
        .iter()
        .filter_map(|runtime| match runtime_telemetry(&system, runtime) {
            Some(telemetry) => Some(telemetry),
            None => {
                if !partial.iter().any(|metric| metric == "runtime") {
                    partial.push("runtime".to_string());
                }
                None
            }
        })
        .collect();
    let uptime_seconds = System::uptime();
    Ok(Observation {
        device_id: config.device_id.clone(),
        environment_id: config.environment_id.clone(),
        health: if partial.is_empty() {
            "healthy"
        } else {
            "degraded"
        }
        .into(),
        host_id: config.host_id.clone(),
        hostd_version: env!("CARGO_PKG_VERSION").into(),
        observation_id: uuid::Uuid::new_v4().to_string(),
        observed_at: rfc3339_now()?,
        partial_metrics: partial,
        protocol_version: 1,
        resources: Resources {
            architecture: std::env::consts::ARCH.into(),
            cpu: Cpu {
                cores: system.cpus().len() as f64,
                used_percent: rounded_percent(system.global_cpu_usage() as f64),
            },
            memory: Memory {
                available_bytes: system.available_memory(),
                total_bytes: system.total_memory(),
            },
            operating_system: format!(
                "{} {}",
                System::name().unwrap_or_else(|| std::env::consts::OS.into()),
                System::os_version().unwrap_or_default()
            )
            .trim()
            .into(),
            storage: Storage {
                available_bytes: available_storage,
                total_bytes: total_storage,
            },
        },
        runtimes,
        schema_version: 1,
        sequence,
        message_type: "hostd.telemetry".into(),
        uptime_seconds,
    })
}

fn runtime_telemetry(system: &System, runtime: &RegisteredRuntime) -> Option<RuntimeTelemetry> {
    if runtime.process_group_leader_pid != runtime.process_group_id {
        return None;
    }
    system.process(sysinfo::Pid::from_u32(runtime.process_group_leader_pid))?;
    if crate::process_identity::read(runtime.process_group_leader_pid).as_deref()
        != Some(runtime.process_group_leader_identity.as_str())
    {
        return None;
    }
    #[cfg(unix)]
    if (unsafe { libc::getpgid(runtime.process_group_leader_pid as libc::pid_t) })
        != runtime.process_group_id as libc::pid_t
    {
        return None;
    }
    let processes: Vec<_> = system
        .processes()
        .values()
        .filter(|process| {
            #[cfg(unix)]
            {
                // SAFETY: getpgid only reads kernel process metadata for the observed PID.
                (unsafe { libc::getpgid(process.pid().as_u32() as libc::pid_t) })
                    == runtime.process_group_id as libc::pid_t
            }
            #[cfg(not(unix))]
            {
                let _ = process;
                false
            }
        })
        .collect();
    if processes.is_empty() {
        return None;
    }
    Some(RuntimeTelemetry {
        boundary_kind: "process_group".into(),
        cpu_percent: rounded_percent(
            (processes
                .iter()
                .map(|process| process.cpu_usage() as f64)
                .sum::<f64>()
                / system.cpus().len().max(1) as f64)
                .min(100.0),
        ),
        generation: runtime.generation.clone(),
        memory_bytes: processes.iter().map(|process| process.memory()).sum(),
        workspace_id: runtime.workspace_id.clone(),
    })
}

fn rounded_percent(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

fn largest_local_storage(disks: &Disks) -> Option<(u64, u64)> {
    let disk = disks
        .list()
        .iter()
        .filter(|disk| !disk.is_removable())
        .max_by_key(|disk| disk.total_space())?;
    Some((disk.total_space(), disk.available_space()))
}

fn rfc3339_now() -> Result<String, String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| "cannot format system time".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn direct_measurement_is_bounded_and_nonempty() {
        let config = test_config(vec![]);
        let observation = collect(&config, 1).expect("collect metrics");
        assert!(observation.resources.cpu.cores >= 1.0);
        assert!((0.0..=100.0).contains(&observation.resources.cpu.used_percent));
        assert!(
            observation.resources.memory.available_bytes
                <= observation.resources.memory.total_bytes
        );
        assert!(
            observation.resources.storage.available_bytes
                <= observation.resources.storage.total_bytes
        );
        assert!(observation.runtimes.is_empty());
        let direct_system = System::new_all();
        assert_eq!(
            observation.resources.memory.total_bytes,
            direct_system.total_memory()
        );
        let direct_disks = Disks::new_with_refreshed_list();
        let direct_storage = direct_disks
            .list()
            .iter()
            .filter(|disk| !disk.is_removable())
            .map(|disk| disk.total_space())
            .max()
            .expect("largest local filesystem");
        assert_eq!(observation.resources.storage.total_bytes, direct_storage);
        let mut adjacent_system = System::new_all();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        adjacent_system.refresh_all();
        assert!(
            (observation.resources.cpu.used_percent - adjacent_system.global_cpu_usage() as f64)
                .abs()
                <= 5.0
        );
        assert!(
            relative_difference(
                observation.resources.memory.available_bytes,
                adjacent_system.available_memory()
            ) <= 0.10
        );
        let adjacent_disks = Disks::new_with_refreshed_list();
        let (_, adjacent_available) = largest_local_storage(&adjacent_disks).unwrap();
        assert!(
            relative_difference(
                observation.resources.storage.available_bytes,
                adjacent_available
            ) <= 0.10
        );
    }

    #[cfg(unix)]
    #[test]
    fn attributes_only_an_explicitly_registered_process_group() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .process_group(0)
            .spawn()
            .expect("spawn isolated process group");
        let pid = child.id();
        let process_group_id = pid;
        let identity = crate::process_identity::read(pid).expect("current process identity");
        let config = test_config(vec![RegisteredRuntime {
            generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
            process_group_leader_identity: identity.clone(),
            process_group_leader_pid: pid,
            process_group_id,
            workspace_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
        }]);
        let observation = collect(&config, 1).expect("collect registered runtime");
        assert_eq!(observation.runtimes.len(), 1);
        assert_eq!(observation.runtimes[0].boundary_kind, "process_group");
        assert!(observation.runtimes[0].memory_bytes > 0);
        let mut direct_system = System::new_all();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        direct_system.refresh_all();
        let direct =
            runtime_telemetry(&direct_system, &config.runtimes[0]).expect("direct runtime sample");
        assert!(
            relative_difference(observation.runtimes[0].memory_bytes, direct.memory_bytes) <= 0.10
        );
        assert!((observation.runtimes[0].cpu_percent - direct.cpu_percent).abs() <= 10.0);

        let wrong_identity = test_config(vec![RegisteredRuntime {
            process_group_leader_identity: format!("{identity}-changed"),
            ..config.runtimes[0].clone()
        }]);
        let rejected = collect(&wrong_identity, 2).expect("collect mismatched runtime");
        assert!(rejected.runtimes.is_empty());
        assert_eq!(rejected.partial_metrics, vec!["runtime"]);
        child.kill().expect("stop isolated process group");
        child.wait().expect("reap isolated process group");
    }

    #[test]
    fn multiple_missing_boundaries_emit_one_partial_marker() {
        let config = test_config(vec![missing_runtime(91), missing_runtime(92)]);
        let observation = collect(&config, 1).expect("collect partial metrics");
        assert_eq!(observation.partial_metrics, vec!["runtime"]);
        assert!(observation.runtimes.is_empty());
    }

    fn missing_runtime(suffix: u32) -> RegisteredRuntime {
        RegisteredRuntime {
            generation: format!("cccccccc-cccc-4ccc-8ccc-{suffix:012}"),
            process_group_id: u32::MAX - suffix,
            process_group_leader_identity: "missing:1".into(),
            process_group_leader_pid: u32::MAX - suffix,
            workspace_id: format!("dddddddd-dddd-4ddd-8ddd-{suffix:012}"),
        }
    }

    fn test_config(runtimes: Vec<RegisteredRuntime>) -> Config {
        Config {
            device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            endpoint: "http://127.0.0.1:1".into(),
            environment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            host_id: None,
            interval_seconds: 30,
            runtimes,
            schema_version: 1,
            state_path: PathBuf::from("/tmp/hostd-test-state"),
            token: "A".repeat(43),
        }
    }

    fn relative_difference(left: u64, right: u64) -> f64 {
        let maximum = left.max(right).max(1) as f64;
        left.abs_diff(right) as f64 / maximum
    }
}
