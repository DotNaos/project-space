#!/usr/bin/env python3

import argparse
import errno
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Set


VALID_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")
FALLBACK_CODE = re.compile(r"^([A-Za-z]+)-[A-Z0-9]{6}$")
LEASE_DURATION = timedelta(hours=48)
PREFIXES = (
    "Ae", "Al", "Ar", "Bel", "Bri", "Ca", "Cor", "Da",
    "El", "Fa", "Fen", "Gal", "Hal", "Is", "Jo", "Ka",
    "Kel", "La", "Lor", "Ma", "Mer", "Na", "Nor", "Or",
    "Per", "Quin", "Ra", "Sel", "Tal", "Val", "Wen", "Ze",
)
MIDDLES = (
    "ba", "ce", "di", "el", "fi", "ga", "ha", "io",
    "ka", "lu", "mi", "no", "or", "ra", "su", "ve",
)
SUFFIXES = (
    "den", "dra", "el", "en", "er", "ia", "ian", "il",
    "in", "io", "is", "on", "or", "os", "ra", "ran",
    "ren", "ria", "ric", "rin", "ro", "sa", "sel", "sor",
    "ta", "th", "tor", "va", "ven", "yn", "yor", "zen",
)


class Claim(NamedTuple):
    name: str
    renewed_at: datetime


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Select a leased, stable, clean, collision-free Codex agent display name."
    )
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--current-name")
    parser.add_argument("--used-name", action="append", default=[])
    parser.add_argument("--visible-thread-id", action="append", default=[])
    parser.add_argument("--visible-tasks-complete", action="store_true")
    parser.add_argument(
        "--state-file",
        type=Path,
        default=Path.home() / ".codex" / "state" / "agent-name-reservations.json",
    )
    parser.add_argument("--now", help=argparse.SUPPRESS)
    parser.add_argument(
        "--project-cli",
        help="Invoke this Project CLI under the reservation lock instead of reading JSON from stdin.",
    )
    return parser.parse_args()


def normalized(value: str) -> str:
    return value.strip().casefold()


def clean_name(value: str) -> str:
    candidate = value.strip()
    match = FALLBACK_CODE.fullmatch(candidate)
    return match.group(1) if match else candidate


def require_name(value: str, label: str) -> str:
    candidate = clean_name(value)
    if not VALID_NAME.fullmatch(candidate):
        raise ValueError(f"{label} is not a valid agent name")
    return candidate


def parse_time(value: str, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} is not a valid timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def format_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def candidate_pool(thread_id: str) -> Iterable[str]:
    names = [
        prefix + middle + suffix
        for prefix in PREFIXES
        for middle in MIDDLES
        for suffix in SUFFIXES
    ]
    digest = hashlib.sha256(thread_id.encode("utf-8")).digest()
    start = int.from_bytes(digest[:8], "big") % len(names)
    step = (int.from_bytes(digest[8:16], "big") % (len(names) // 2)) * 2 + 1
    for offset in range(len(names)):
        yield names[(start + offset * step) % len(names)]


def load_claims(state_file: Path) -> Dict[str, Claim]:
    if not state_file.exists():
        return {}
    with state_file.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    version = payload.get("version")
    raw_claims = payload.get("claims")
    if version not in {1, 2} or not isinstance(raw_claims, dict):
        raise ValueError("agent-name reservation state has an unsupported format")
    migrated_at = datetime.fromtimestamp(state_file.stat().st_mtime, timezone.utc)
    claims: Dict[str, Claim] = {}
    for thread_id, raw_claim in raw_claims.items():
        if not isinstance(thread_id, str):
            continue
        if version == 1 and isinstance(raw_claim, str):
            claims[thread_id] = Claim(require_name(raw_claim, "stored name"), migrated_at)
        elif version == 2 and isinstance(raw_claim, dict):
            name = raw_claim.get("name")
            renewed_at = raw_claim.get("renewedAt")
            if isinstance(name, str) and isinstance(renewed_at, str):
                claims[thread_id] = Claim(
                    require_name(name, "stored name"),
                    parse_time(renewed_at, "stored renewal time"),
                )
    return claims


def save_claims(
    state_file: Path, claims: Dict[str, Claim], platform_name: str = None
) -> None:
    state_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = {
        "version": 2,
        "leaseHours": 48,
        "claims": {
            thread_id: {"name": claim.name, "renewedAt": format_time(claim.renewed_at)}
            for thread_id, claim in sorted(claims.items())
        },
    }
    file_descriptor, temporary_path = tempfile.mkstemp(
        dir=str(state_file.parent), prefix=".agent-name-reservations.", text=True
    )
    try:
        if (platform_name or os.name) != "nt":
            os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, state_file)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def renew_visible_claims(
    claims: Dict[str, Claim], used: Set[str], visible_thread_ids: Set[str], now: datetime
) -> None:
    for thread_id, claim in list(claims.items()):
        if thread_id in visible_thread_ids or normalized(claim.name) in used:
            claims[thread_id] = Claim(claim.name, now)


def prune_expired_claims(
    claims: Dict[str, Claim], current_thread_id: str, visible_thread_ids: Set[str], now: datetime
) -> None:
    for thread_id, claim in list(claims.items()):
        if (
            thread_id != current_thread_id
            and thread_id not in visible_thread_ids
            and claim.renewed_at + LEASE_DURATION <= now
        ):
            del claims[thread_id]


def lock_state_file(lock_handle, platform_name: str = None, sleep=time.sleep) -> None:
    platform = platform_name or os.name
    if platform != "nt":
        import fcntl

        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        return

    import msvcrt

    lock_handle.seek(0, os.SEEK_END)
    if lock_handle.tell() == 0:
        lock_handle.write("\0")
        lock_handle.flush()
    lock_handle.seek(0)
    while True:
        try:
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError as error:
            if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            sleep(0.05)


def select_name(
    thread_id: str,
    source: str,
    cli_name: str,
    current_name: str,
    used_names: List[str],
    claims: Dict[str, Claim],
) -> str:
    used: Set[str] = {
        normalized(require_name(name, "used name")) for name in used_names if name.strip()
    }
    reserved = {
        normalized(claim.name)
        for claim_thread_id, claim in claims.items()
        if claim_thread_id != thread_id
    }
    unavailable = used | reserved

    if source == "project-space":
        candidate = require_name(cli_name, "Project Space name")
        if normalized(candidate) in unavailable:
            raise ValueError("Project Space returned an already leased agent name")
        return candidate

    preferred: List[str] = []
    if current_name:
        preferred.append(require_name(current_name, "current name"))
    if thread_id in claims:
        preferred.append(claims[thread_id].name)
    preferred.append(require_name(cli_name, "fallback name"))

    seen: Set[str] = set()
    for candidate in preferred:
        key = normalized(candidate)
        if key not in seen and key not in unavailable:
            return candidate
        seen.add(key)
    for candidate in candidate_pool(thread_id):
        if normalized(candidate) not in unavailable:
            return candidate
    raise ValueError("no clean agent name remains available")


def cli_payload_under_lock(
    args: argparse.Namespace, claims: Dict[str, Claim]
) -> dict:
    excluded = {
        normalized(claim.name): claim.name
        for claim_thread_id, claim in claims.items()
        if claim_thread_id != args.thread_id
    }
    for name in args.used_name:
        if name.strip():
            candidate = require_name(name, "used name")
            excluded[normalized(candidate)] = candidate
    command = [args.project_cli, "agent", "name", "--format", "json"]
    for name in sorted(excluded.values(), key=normalized):
        command.extend(["--exclude", name])
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        diagnostic = completed.stderr.strip() or completed.stdout.strip()
        raise ValueError(
            f"Project CLI agent-name command failed: {diagnostic or completed.returncode}"
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Project CLI returned invalid agent-name JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("Project CLI returned invalid agent-name JSON")
    return payload


def select_and_save(
    args: argparse.Namespace,
    claims: Dict[str, Claim],
    now: datetime,
    cli_payload: dict,
    platform_name: str = None,
) -> dict:
    cli_name = cli_payload.get("name")
    source = cli_payload.get("source")
    warning = cli_payload.get("warning")
    if not isinstance(cli_name, str) or source not in {"project-space", "fallback"}:
        raise ValueError("Project CLI returned an invalid agent-name result")
    if not isinstance(warning, str):
        raise ValueError("Project CLI returned an invalid warning")
    name = select_name(
        args.thread_id,
        source,
        cli_name,
        args.current_name or "",
        args.used_name,
        claims,
    )
    claims[args.thread_id] = Claim(name, now)
    save_claims(args.state_file.expanduser().resolve(), claims, platform_name)
    return {"name": name, "source": source, "warning": warning}


def run(
    args: argparse.Namespace, cli_payload: dict = None, platform_name: str = None
) -> dict:
    now = parse_time(args.now, "current time") if args.now else datetime.now(timezone.utc)
    state_file = args.state_file.expanduser().resolve()
    state_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = state_file.with_suffix(state_file.suffix + ".lock")
    lock_descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_descriptor, "r+") as lock_handle:
        lock_state_file(lock_handle, platform_name)
        claims = load_claims(state_file)
        used = {
            normalized(require_name(name, "used name"))
            for name in args.used_name
            if name.strip()
        }
        visible_thread_ids = {
            thread_id.strip()
            for thread_id in getattr(args, "visible_thread_id", [])
            if thread_id.strip()
        }
        renew_visible_claims(claims, used, visible_thread_ids, now)
        if getattr(args, "visible_tasks_complete", False):
            prune_expired_claims(claims, args.thread_id, visible_thread_ids, now)
        payload = cli_payload
        if args.project_cli:
            payload = cli_payload_under_lock(args, claims)
        if not isinstance(payload, dict):
            raise ValueError("Project CLI returned invalid agent-name JSON")
        return select_and_save(args, claims, now, payload, platform_name)


def main() -> int:
    args = parse_args()
    payload = None if args.project_cli else json.load(sys.stdin)
    result = run(args, payload)
    json.dump(result, sys.stdout, ensure_ascii=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"agent-name selection failed: {error}", file=sys.stderr)
        raise SystemExit(1)
