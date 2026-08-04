#!/usr/bin/env python3
"""Create and verify the immutable PR Preview artifact contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

IMAGE_NAMES = ("web", "docs", "prototype")
RECIPE_PATHS = (
    "deploy/preview-artifact-bake.hcl",
    "deploy/preview.web.Dockerfile",
    "deploy/preview.docs.Dockerfile",
    "deploy/preview.prototype.Dockerfile",
    "deploy/preview.prototype.nginx.conf",
)
EXPECTED_MEMBERS = ("manifest.json", *(f"images/{name}.tar" for name in IMAGE_NAMES))
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
WORKFLOW_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/.+@refs/(heads|pull)/.+$")
MAX_MANIFEST_BYTES = 64 * 1024
MAX_MEMBER_BYTES = 4 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024


def fail(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def positive_integer(value: str, label: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        fail(f"{label} must be a positive integer")
    return int(value)


def regular_file(path: Path, label: str) -> os.stat_result:
    result = path.lstat()
    if not stat.S_ISREG(result.st_mode):
        fail(f"{label} must be a regular file")
    return result


def create_manifest(args: argparse.Namespace) -> None:
    if not REPOSITORY_RE.fullmatch(args.repository):
        fail("repository must be owner/name")
    if not GIT_SHA_RE.fullmatch(args.head_sha):
        fail("head SHA must be a full lowercase Git SHA")
    if not WORKFLOW_RE.fullmatch(args.workflow_ref):
        fail("workflow ref must identify a workflow on a branch")

    root = Path(args.root).resolve()
    output = Path(args.output).resolve()
    images: dict[str, Any] = {}
    for name in IMAGE_NAMES:
        relative = f"images/{name}.tar"
        path = output.parent / relative
        file_stat = regular_file(path, relative)
        images[name] = {
            "archive": relative,
            "localTag": f"project-space-preview-{name}:pr-{args.pr}-{args.head_sha}",
            "sha256": sha256(path),
            "size": file_stat.st_size,
        }

    recipes: dict[str, str] = {}
    for relative in RECIPE_PATHS:
        path = root / relative
        regular_file(path, relative)
        recipes[relative] = sha256(path)

    manifest = {
        "schemaVersion": 1,
        "repository": {
            "id": positive_integer(args.repository_id, "repository ID"),
            "fullName": args.repository,
        },
        "pullRequestNumber": positive_integer(args.pr, "pull request number"),
        "headSha": args.head_sha,
        "source": {
            "event": "pull_request",
            "workflowRef": args.workflow_ref,
            "runId": positive_integer(args.run_id, "run ID"),
            "runAttempt": positive_integer(args.run_attempt, "run attempt"),
        },
        "recipes": recipes,
        "images": images,
    }
    output.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} has an unexpected shape")
    return value


def verify_manifest(args: argparse.Namespace) -> None:
    root = Path(args.root).resolve()
    manifest_path = root / "manifest.json"
    manifest_stat = regular_file(manifest_path, "manifest.json")
    if manifest_stat.st_size > MAX_MANIFEST_BYTES:
        fail("manifest.json exceeds the size limit")
    manifest = json.loads(manifest_path.read_text())
    manifest = exact_keys(
        manifest,
        {"schemaVersion", "repository", "pullRequestNumber", "headSha", "source", "recipes", "images"},
        "manifest",
    )
    if manifest["schemaVersion"] != 1:
        fail("unsupported Preview artifact schema")

    repository = exact_keys(manifest["repository"], {"id", "fullName"}, "repository")
    expected_repository_id = positive_integer(args.repository_id, "repository ID")
    if repository != {"id": expected_repository_id, "fullName": args.repository}:
        fail("repository identity does not match the trusted request")
    if manifest["pullRequestNumber"] != positive_integer(args.pr, "pull request number"):
        fail("pull request number does not match the trusted request")
    if manifest["headSha"] != args.head_sha or not GIT_SHA_RE.fullmatch(manifest["headSha"]):
        fail("head SHA does not match the trusted request")

    source = exact_keys(manifest["source"], {"event", "workflowRef", "runId", "runAttempt"}, "source")
    expected_source = {
        "event": "pull_request",
        "workflowRef": args.workflow_ref,
        "runId": positive_integer(args.run_id, "run ID"),
        "runAttempt": positive_integer(args.run_attempt, "run attempt"),
    }
    if source != expected_source:
        fail("source workflow identity does not match the trusted request")

    recipes = exact_keys(manifest["recipes"], set(RECIPE_PATHS), "recipes")
    if not all(isinstance(value, str) and SHA256_RE.fullmatch(value) for value in recipes.values()):
        fail("recipe hashes must be lowercase SHA-256 values")

    images = exact_keys(manifest["images"], set(IMAGE_NAMES), "images")
    for name in IMAGE_NAMES:
        image = exact_keys(images[name], {"archive", "localTag", "sha256", "size"}, f"image {name}")
        relative = f"images/{name}.tar"
        expected_tag = f"project-space-preview-{name}:pr-{args.pr}-{args.head_sha}"
        if image["archive"] != relative or image["localTag"] != expected_tag:
            fail(f"image {name} identity is invalid")
        if not isinstance(image["sha256"], str) or not SHA256_RE.fullmatch(image["sha256"]):
            fail(f"image {name} digest is invalid")
        if type(image["size"]) is not int or image["size"] <= 0 or image["size"] > MAX_MEMBER_BYTES:
            fail(f"image {name} size is invalid")
        path = root / relative
        file_stat = regular_file(path, relative)
        if file_stat.st_size != image["size"] or sha256(path) != image["sha256"]:
            fail(f"image {name} archive does not match its manifest")

    print(json.dumps(manifest, sort_keys=True, separators=(",", ":")))


def safe_extract(args: argparse.Namespace) -> None:
    archive = Path(args.archive).resolve()
    destination = Path(args.destination).resolve()
    archive_stat = regular_file(archive, "artifact archive")
    if archive_stat.st_size != int(args.expected_size):
        fail("artifact archive size does not match GitHub metadata")
    expected_digest = args.expected_digest.removeprefix("sha256:")
    if not SHA256_RE.fullmatch(expected_digest) or sha256(archive) != expected_digest:
        fail("artifact archive digest does not match GitHub metadata")

    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        fail("artifact extraction directory must be empty")

    seen: set[str] = set()
    total_size = 0
    allowed_directories = {"images/"}
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name = member.filename
            normalized = PurePosixPath(name)
            if name in seen or "\\" in name or normalized.is_absolute() or ".." in normalized.parts:
                fail(f"unsafe or duplicate artifact member: {name}")
            seen.add(name)
            mode = member.external_attr >> 16
            if member.flag_bits & 0x1:
                fail(f"encrypted artifact member is forbidden: {name}")
            if member.is_dir():
                if name not in allowed_directories:
                    fail(f"unexpected artifact directory: {name}")
                continue
            if name not in EXPECTED_MEMBERS:
                fail(f"unexpected artifact member: {name}")
            if mode and not stat.S_ISREG(mode):
                fail(f"artifact member is not a regular file: {name}")
            if member.file_size <= 0 or member.file_size > MAX_MEMBER_BYTES:
                fail(f"artifact member size is invalid: {name}")
            total_size += member.file_size
            if total_size > MAX_TOTAL_BYTES:
                fail("artifact exceeds the total extraction limit")

        if not set(EXPECTED_MEMBERS).issubset(seen):
            fail("artifact file inventory is incomplete")

        for name in EXPECTED_MEMBERS:
            target = destination / PurePosixPath(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(name) as source, target.open("xb") as output:
                copied = 0
                while chunk := source.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > MAX_MEMBER_BYTES:
                        fail(f"artifact member exceeded its extraction limit: {name}")
                    output.write(chunk)
                if copied != bundle.getinfo(name).file_size:
                    fail(f"artifact member extraction was incomplete: {name}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subcommands = result.add_subparsers(dest="command", required=True)

    for command in ("create", "verify"):
        sub = subcommands.add_parser(command)
        sub.add_argument("--root", required=True)
        sub.add_argument("--repository", required=True)
        sub.add_argument("--repository-id", required=True)
        sub.add_argument("--pr", required=True)
        sub.add_argument("--head-sha", required=True)
        sub.add_argument("--workflow-ref", required=True)
        sub.add_argument("--run-id", required=True)
        sub.add_argument("--run-attempt", required=True)
        if command == "create":
            sub.add_argument("--output", required=True)

    extract = subcommands.add_parser("safe-extract")
    extract.add_argument("--archive", required=True)
    extract.add_argument("--destination", required=True)
    extract.add_argument("--expected-digest", required=True)
    extract.add_argument("--expected-size", required=True)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        if args.command == "create":
            create_manifest(args)
        elif args.command == "verify":
            verify_manifest(args)
        else:
            safe_extract(args)
        return 0
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"Preview artifact verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
