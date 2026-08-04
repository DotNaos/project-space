import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("install.py")
SPEC = importlib.util.spec_from_file_location("claim_agent_name_install", SCRIPT)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_installs_a_managed_file_on_windows_without_fchmod(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            installer.os, "fchmod", side_effect=AssertionError("Unix-only call")
        ):
            root = Path(directory)
            source = root / "source.txt"
            target = root / "nested" / "target.txt"
            source.write_text("versioned skill\n", encoding="utf-8")
            installer.install_file(source, target, platform_name="nt")
            self.assertEqual(source.read_bytes(), target.read_bytes())


if __name__ == "__main__":
    unittest.main()
