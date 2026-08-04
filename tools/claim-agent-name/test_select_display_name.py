import importlib.util
import errno
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


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
            "visible_thread_id": [],
            "visible_tasks_complete": False,
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

    def test_skill_requires_complete_pagination_before_local_reclamation(self):
        instructions = SCRIPT.with_name("SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Follow every returned next cursor", instructions)
        self.assertIn("--visible-tasks-complete", instructions)
        self.assertIn("preserves unseen local leases", instructions)

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
                visible_tasks_complete=True,
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
            expired = self.args(
                state,
                "thread-b",
                "2026-08-03T00:00:00Z",
                visible_tasks_complete=True,
            )
            self.assertEqual(
                "Aebaden",
                selector.run(expired, self.payload("Aebaden", "project-space"))["name"],
            )

    def test_incomplete_visibility_never_reclaims_an_unseen_live_task(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "claims.json"
            selector.run(self.args(state, "thread-a", "2026-08-01T00:00:00Z"), self.payload())
            incomplete = self.args(state, "thread-b", "2026-08-03T00:00:00Z")
            self.assertNotEqual("Aebaden", selector.run(incomplete, self.payload())["name"])
            self.assertIn("thread-a", selector.load_claims(state))

    def test_complete_visibility_preserves_a_visible_task_with_an_unstructured_title(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "claims.json"
            selector.run(self.args(state, "thread-a", "2026-08-01T00:00:00Z"), self.payload())
            visible = self.args(
                state,
                "thread-b",
                "2026-08-03T00:00:00Z",
                visible_thread_id=["thread-a"],
                visible_tasks_complete=True,
            )
            self.assertNotEqual("Aebaden", selector.run(visible, self.payload())["name"])
            self.assertEqual(
                "2026-08-03T00:00:00Z",
                selector.format_time(selector.load_claims(state)["thread-a"].renewed_at),
            )

    def test_windows_lock_retries_with_msvcrt_without_importing_fcntl(self):
        calls = []

        def locking(file_descriptor, mode, count):
            calls.append((file_descriptor, mode, count))
            if len(calls) == 1:
                raise OSError(errno.EACCES, "busy")

        fake_msvcrt = SimpleNamespace(LK_NBLCK=2, locking=locking)
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / "claims.lock"
            with lock_path.open("w+") as lock_handle, patch.dict(sys.modules, {"msvcrt": fake_msvcrt}):
                selector.lock_state_file(lock_handle, platform_name="nt", sleep=lambda _: None)
            self.assertEqual(2, len(calls))
            self.assertEqual(1, lock_path.stat().st_size)

    def test_full_selector_saves_state_with_the_windows_lock_path(self):
        fake_msvcrt = SimpleNamespace(LK_NBLCK=2, locking=lambda *_: None)
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, {"msvcrt": fake_msvcrt}
        ), patch.object(selector.os, "fchmod", side_effect=AssertionError("Unix-only call")):
            state = Path(directory) / "claims.json"
            result = selector.run(
                self.args(state, "thread-a", "2026-08-01T00:00:00Z"),
                self.payload(),
                platform_name="nt",
            )
            self.assertEqual("Aebaden", result["name"])
            self.assertEqual("Aebaden", selector.load_claims(state)["thread-a"].name)

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

    def test_online_restart_prefers_the_same_threads_offline_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            state=root / "claims.json"
            invocation=root / "preferred.txt"
            selector.run(
                self.args(state,"thread-a","2026-08-01T00:00:00Z"),self.payload()
            )
            fake_cli=root / "project"
            fake_cli.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os\n"
                f"preferred=os.environ[{selector.PREFERRED_NAME_ENVIRONMENT!r}]\n"
                f"open({str(invocation)!r},'w').write(preferred)\n"
                "print(json.dumps({'name':preferred,'source':'project-space','warning':''}))\n",
                encoding="utf-8",
            )
            os.chmod(fake_cli,0o700)
            result=selector.run(self.args(
                state,"thread-a","2026-08-02T00:00:00Z",project_cli=str(fake_cli)
            ))
            self.assertEqual("Aebaden",result["name"])
            self.assertEqual("Aebaden",invocation.read_text(encoding="utf-8"))

    def test_large_lease_sets_use_a_bounded_exclusion_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            state=root / "claims.json"
            invocation=root / "invocation.json"
            names=list(selector.candidate_pool("pool"))[:3_000]
            selector.save_claims(state,{
                f"thread-{index}":selector.Claim(name,selector.parse_time("2026-08-01T00:00:00Z","time"))
                for index,name in enumerate(names)
            })
            fake_cli=root / "project"
            fake_cli.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                "args=sys.argv[1:]\n"
                "index=args.index('--exclude-file')\n"
                "path=pathlib.Path(args[index+1])\n"
                f"json.dump({{'args':args,'names':path.read_text().splitlines()}},open({str(invocation)!r},'w'))\n"
                "print(json.dumps({'name':'Athena','source':'project-space','warning':''}))\n",
                encoding="utf-8",
            )
            os.chmod(fake_cli,0o700)
            result=selector.run(self.args(
                state,"current-thread","2026-08-01T01:00:00Z",project_cli=str(fake_cli)
            ))
            self.assertEqual("Athena",result["name"])
            recorded=json.loads(invocation.read_text(encoding="utf-8"))
            self.assertNotIn("--exclude",recorded["args"])
            self.assertEqual(sorted(names,key=str.casefold),recorded["names"])
            exclusion_path=recorded["args"][recorded["args"].index("--exclude-file")+1]
            self.assertFalse(Path(exclusion_path).exists())
            self.assertLess(sum(len(part)+3 for part in recorded["args"]),1_000)

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
