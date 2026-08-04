#!/usr/bin/env python3

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path


SOURCE = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the versioned claim-agent-name skill.")
    parser.add_argument(
        "--target",
        type=Path,
        default=Path.home() / ".codex" / "skills" / "claim-agent-name",
    )
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def managed_files(target: Path):
    return (
        (SOURCE / "SKILL.md", target / "SKILL.md"),
        (SOURCE / "select_display_name.py", target / "scripts" / "select_display_name.py"),
    )


def matches(source: Path, target: Path) -> bool:
    return target.is_file() and source.read_bytes() == target.read_bytes()


def install_file(source: Path, target: Path, platform_name: str = None) -> None:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        if (platform_name or os.name) != "nt":
            os.fchmod(descriptor, source.stat().st_mode & 0o777)
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    args = parse_args()
    files = managed_files(args.target.expanduser().resolve())
    if args.check:
        mismatches = [str(target) for source, target in files if not matches(source, target)]
        if mismatches:
            print("claim-agent-name skill is outdated: " + ", ".join(mismatches), file=sys.stderr)
            return 1
        print("claim-agent-name skill is current")
        return 0
    for source, target in files:
        install_file(source, target)
    print(f"installed claim-agent-name skill in {args.target.expanduser().resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
