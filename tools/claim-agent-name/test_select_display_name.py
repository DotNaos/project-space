import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("select_display_name.py")
SPEC = importlib.util.spec_from_file_location("select_display_name", SCRIPT)
assert SPEC and SPEC.loader
selector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(selector)


class SelectorLeaseTests(unittest.TestCase):
    def args(self, state_file: Path, thread_id: str, now: str, **overrides):
        values = {
            "state_file": state_file,
            "thread_id": thread_id,
            "now": now,
            "current_name": None,
            "used_name": [],
            "project_cli": None,
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def payload(self, name="Aebaden-222222", source="fallback"):
        return {"name": name, "source": source, "warning": "offline" if source == "fallback" else ""}

    def test_pool_is_deterministic_and_dramatically_larger(self):
        first = list(selector.candidate_pool("thread-a"))
        second = list(selector.candidate_pool("thread-a"))
        self.assertEqual(16_384, len(first))
        self.assertEqual(first, second)
        self.assertEqual(len(first), len(set(first)))

    def test_lease_renews_before_expiry_and_reclaims_at_exact_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "claims.json"
            first = self.args(state, "thread-a", "2026-08-01T00:00:00Z")
            self.assertEqual("Aebaden", selector.run(first, self.payload())["name"])

            renewal = self.args(
                state,
                "thread-a",
                "2026-08-02T23:59:59.999Z",
                current_name="Aebaden",
            )
            self.assertEqual("Aebaden", selector.run(renewal, self.payload())["name"])

            before = self.args(state, "thread-b", "2026-08-04T23:59:59.998Z")
            self.assertNotEqual("Aebaden", selector.run(before, self.payload())["name"])

            exact = self.args(
                state,
                "thread-c",
                "2026-08-04T23:59:59.999Z",
            )
            self.assertEqual("Aebaden", selector.run(exact, self.payload())["name"])

    def test_visible_use_renews_an_otherwise_expired_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "claims.json"
            selector.run(self.args(state, "thread-a", "2026-08-01T00:00:00Z"), self.payload())
            active = self.args(
                state,
                "thread-b",
                "2026-08-03T00:00:00Z",
                used_name=["Aebaden"],
            )
            self.assertNotEqual("Aebaden", selector.run(active, self.payload())["name"])
            stored = selector.load_claims(state)
            self.assertEqual("2026-08-03T00:00:00Z", selector.format_time(stored["thread-a"].renewed_at))

    def test_online_claim_reconciles_only_after_local_lease_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "claims.json"
            selector.run(self.args(state, "thread-a", "2026-08-01T00:00:00Z"), self.payload())
            fresh = self.args(state, "thread-b", "2026-08-02T00:00:00Z")
            with self.assertRaisesRegex(ValueError, "already leased"):
                selector.run(fresh, self.payload("Aebaden", "project-space"))
            expired = self.args(state, "thread-b", "2026-08-03T00:00:00Z")
            self.assertEqual(
                "Aebaden",
                selector.run(expired, self.payload("Aebaden", "project-space"))["name"],
            )

    def test_wrapper_excludes_live_local_leases_before_online_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "claims.json"
            invocation = root / "invocation.json"
            fake_cli = root / "project"
            fake_cli.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                f"json.dump(sys.argv[1:], open({str(invocation)!r}, 'w'))\n"
                "print(json.dumps({'name':'Albaden','source':'project-space','warning':''}))\n",
                encoding="utf-8",
            )
            os.chmod(fake_cli, 0o700)
            selector.run(
                self.args(state, "thread-a", "2026-08-01T00:00:00Z"),
                self.payload(),
            )

            wrapped = self.args(
                state,
                "thread-b",
                "2026-08-02T00:00:00Z",
                project_cli=str(fake_cli),
            )
            self.assertEqual("Albaden", selector.run(wrapped)["name"])
            arguments = json.loads(invocation.read_text(encoding="utf-8"))
            self.assertEqual(["agent", "name", "--format", "json"], arguments[:4])
            self.assertIn(["--exclude", "Aebaden"], [arguments[index:index + 2] for index in range(len(arguments) - 1)])

    def test_concurrent_processes_share_one_lock_without_duplicate_names(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "claims.json"

            def invoke(index: int):
                thread_id = f"thread-{index:04d}"
                result = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPT),
                        "--thread-id",
                        thread_id,
                        "--state-file",
                        str(state),
                        "--now",
                        "2026-08-01T00:00:00Z",
                    ],
                    input=json.dumps(self.payload()),
                    text=True,
                    capture_output=True,
                    check=True,
                )
                return json.loads(result.stdout)["name"]

            with ThreadPoolExecutor(max_workers=16) as executor:
                names = list(executor.map(invoke, range(64)))
            self.assertEqual(64, len(set(names)))
            self.assertEqual(64, len(selector.load_claims(state)))


if __name__ == "__main__":
    unittest.main()
