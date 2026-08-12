use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

pub fn read(path: &Path, maximum: u64, label: &str) -> Result<Vec<u8>, String> {
    let before = fs::symlink_metadata(path).map_err(|_| format!("cannot read {label}"))?;
    validate_metadata(&before, maximum, label)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| format!("cannot read {label}"))?;
    let metadata = file
        .metadata()
        .map_err(|_| format!("cannot inspect {label}"))?;
    validate_metadata(&metadata, maximum, label)?;
    if !same_file(&before, &metadata) {
        return Err(format!("{label} changed while it was opened"));
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("cannot read {label}"))?;
    if bytes.len() as u64 > maximum {
        return Err(format!("{label} is too large"));
    }
    Ok(bytes)
}

pub fn is_missing(path: &Path) -> bool {
    fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn validate_metadata(metadata: &fs::Metadata, maximum: u64, label: &str) -> Result<(), String> {
    if !metadata.file_type().is_file() || metadata.len() > maximum {
        return Err(format!("{label} must be a bounded regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let effective_user = unsafe { libc::geteuid() };
        if metadata.uid() != 0 && metadata.uid() != effective_user {
            return Err(format!("{label} must be owned by root or the current user"));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!("{label} must not be accessible by group or others"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(_left: &fs::Metadata, _right: &fs::Metadata) -> bool {
    true
}

pub fn write_atomic(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent"))?;
    fs::create_dir_all(parent).map_err(|_| format!("cannot create {label} directory"))?;
    let metadata =
        fs::symlink_metadata(parent).map_err(|_| format!("cannot inspect {label} directory"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} directory is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let effective_user = unsafe { libc::geteuid() };
        if metadata.uid() != 0 && metadata.uid() != effective_user {
            return Err(format!(
                "{label} directory must be owned by root or the current user"
            ));
        }
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| format!("cannot secure {label} directory"))?;
    }
    let temporary = parent.join(format!(".project-hostd-{}.tmp", uuid::Uuid::new_v4()));
    let result = write_temporary(&temporary, bytes, label).and_then(|()| {
        fs::rename(&temporary, path).map_err(|_| format!("cannot publish {label}"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| format!("cannot sync {label} directory"))
    });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_temporary(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| format!("cannot create {label}"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| format!("cannot write {label}"))
}
