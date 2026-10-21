"""Isolated tests: no real sysctl, modules, interfaces or /etc are touched."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("bbr_manage", Path(__file__).resolve().parents[1] / "manage.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeBackend:
    def __init__(self):
        self.values = {"net.ipv4.tcp_congestion_control": "cubic", "net.core.default_qdisc": "fq_codel",
                       "net.ipv4.tcp_rmem": "4096 131072 6291456", "net.core.somaxconn": "4096",
                       "net.ipv4.tcp_available_congestion_control": "reno cubic bbr"}
        self.fail = None
        self.fail_rollback = False
        self.writes = []

    def read(self, key):
        if key not in self.values:
            raise FileNotFoundError(key)
        return self.values[key]

    def prepare(self, entries):
        algorithm = entries.get("net.ipv4.tcp_congestion_control")
        if algorithm and algorithm not in self.values["net.ipv4.tcp_available_congestion_control"].split():
            raise ValueError("内核不支持")

    def write(self, key, value):
        self.writes.append((key, value))
        self.values[key] = module.normalize(value)
        if (key, value) == self.fail:
            self.fail = None
            raise RuntimeError("模拟写入失败（已部分写入）")
        if self.fail_rollback and value == "fq_codel":
            raise RuntimeError("模拟回滚失败")

    def qdiscs(self):
        return "eth0: fq_codel"


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = FakeBackend()
        self.manager = module.Manager(self.backend, self.root)

    def test_parser_rejects_unsafe_empty_duplicate_and_oversize(self):
        for text in ("", "# comment", "kernel.panic=1", "net.ipv4.ip_forward=1", "net.ipv4.tcp_syncookies=$(id)",
                     "net.core.default_qdisc=fq;reboot", "include /tmp/example", "net.ipv4.tcp_*=1",
                     "net.core.somaxconn=1\nnet.core.somaxconn=2", "#" + "x" * 12000):
            with self.subTest(text=text[:70]), self.assertRaises(ValueError):
                module.parse(text)

    def test_parser_preserves_tuples_comments_crlf(self):
        self.assertEqual(module.parse("; hi\r\nnet.ipv4.tcp_rmem = 4096\t131072\t6291456 # ok\r\n"),
                         {"net.ipv4.tcp_rmem": "4096 131072 6291456"})

    def test_read_runtime_is_not_saved_queue_and_no_writes(self):
        detail = self.manager.read()
        self.assertEqual(detail["congestionControl"], "cubic")
        self.assertFalse(detail["persisted"])
        self.assertIn("net.ipv4.tcp_rmem", detail["runtimeText"])
        self.assertEqual(self.backend.writes, [])
        self.manager.apply(module.PRESET)
        self.backend.values["net.ipv4.tcp_congestion_control"] = "reno"
        detail = self.manager.read()
        self.assertFalse(detail["inSync"])
        self.assertIn("= reno", detail["configText"])
        self.assertIn("= bbr", detail["savedConfigText"])
        self.assertEqual(detail["currentQueues"], "eth0: fq_codel")
        self.assertEqual(detail["defaultQdisc"], "fq")

    def test_apply_restore_persistent_state_and_unrelated_files(self):
        other = self.root / "etc/sysctl.d/99-custom.conf"
        other.parent.mkdir(parents=True)
        other.write_text("# third party\n")
        self.manager.apply(module.PRESET)
        self.assertEqual(self.backend.values["net.ipv4.tcp_congestion_control"], "bbr")
        self.assertTrue(self.manager.read()["inSync"])
        # New plugin process/asset sync uses the same external baseline.
        other_manager = module.Manager(self.backend, self.root)
        other_manager.restore()
        self.assertEqual(self.backend.values["net.ipv4.tcp_congestion_control"], "cubic")
        self.assertEqual(self.backend.values["net.core.default_qdisc"], "fq_codel")
        self.assertFalse(other_manager.conf.exists())
        self.assertFalse(other_manager.state.exists())
        self.assertEqual(other.read_text(), "# third party\n")

    def test_add_and_remove_keys_keeps_first_baseline(self):
        self.manager.apply(module.PRESET + "net.core.somaxconn=2048\n")
        self.manager.apply(module.PRESET + "net.core.somaxconn=1024\n")
        self.assertEqual(self.manager.load_state()["values"]["net.core.somaxconn"], "4096")
        self.manager.apply(module.PRESET)
        self.assertEqual(self.backend.values["net.core.somaxconn"], "4096")
        self.manager.restore()
        self.assertEqual(self.backend.values["net.core.default_qdisc"], "fq_codel")

    def test_existing_plugin_file_restored_exactly(self):
        self.manager.conf.parent.mkdir(parents=True)
        original = b"# old plugin config\nnet.core.default_qdisc=fq_codel\n"
        self.manager.conf.write_bytes(original)
        self.manager.apply(module.PRESET)
        self.manager.restore()
        self.assertEqual(self.manager.conf.read_bytes(), original)

    def test_missing_key_or_unsupported_algorithm_no_partial_application(self):
        for text in (module.PRESET + "net.ipv4.tcp_nonexistent=1", "net.ipv4.tcp_congestion_control=bbr3"):
            with self.subTest(text=text), self.assertRaises((FileNotFoundError, ValueError)):
                self.manager.apply(text)
        self.assertEqual(self.backend.writes, [])
        self.assertFalse(self.manager.state.exists())

    def test_partial_apply_failure_rolls_back_runtime_and_files(self):
        self.backend.fail = ("net.ipv4.tcp_congestion_control", "bbr")
        with self.assertRaisesRegex(RuntimeError, "已回滚"):
            self.manager.apply(module.PRESET)
        self.assertEqual(self.backend.values["net.core.default_qdisc"], "fq_codel")
        self.assertEqual(self.backend.values["net.ipv4.tcp_congestion_control"], "cubic")
        self.assertFalse(self.manager.conf.exists())
        self.assertFalse(self.manager.state.exists())

    def test_persistence_failure_restores_running_values_and_previous_state(self):
        self.manager.apply(module.PRESET)
        old_state = self.manager.state.read_bytes()
        old_config = self.manager.conf.read_bytes()
        real_write = module.atomic_write
        failed = False

        def write(path, data):
            nonlocal failed
            if path == self.manager.conf and not failed:
                failed = True
                raise OSError("disk full")
            real_write(path, data)

        with patch.object(module, "atomic_write", side_effect=write), self.assertRaisesRegex(RuntimeError, "已回滚"):
            self.manager.apply("net.ipv4.tcp_congestion_control=reno\n")
        self.assertEqual(self.backend.values["net.ipv4.tcp_congestion_control"], "bbr")
        self.assertEqual(self.backend.values["net.core.default_qdisc"], "fq")
        self.assertEqual(self.manager.conf.read_bytes(), old_config)
        self.assertEqual(self.manager.state.read_bytes(), old_state)

    def test_failed_restore_keeps_baseline_for_retry(self):
        self.manager.apply(module.PRESET)
        self.backend.fail = ("net.ipv4.tcp_congestion_control", "cubic")
        with self.assertRaisesRegex(RuntimeError, "已回滚"):
            self.manager.restore()
        self.assertTrue(self.manager.state.exists())
        self.assertEqual(self.backend.values["net.ipv4.tcp_congestion_control"], "bbr")
        self.manager.restore()
        self.assertFalse(self.manager.state.exists())

    def test_rollback_failure_preserves_recovery_journal(self):
        self.backend.fail = ("net.ipv4.tcp_congestion_control", "bbr")
        self.backend.fail_rollback = True
        with self.assertRaisesRegex(RuntimeError, "部分回滚失败"):
            self.manager.apply(module.PRESET)
        self.assertTrue(self.manager.state.exists())
        self.assertEqual(self.manager.load_state()["values"]["net.core.default_qdisc"], "fq_codel")
        self.backend.fail_rollback = False
        self.manager.restore()
        self.assertFalse(self.manager.state.exists())

    def test_host_baselines_are_isolated(self):
        self.manager.apply(module.PRESET)
        with tempfile.TemporaryDirectory() as second:
            manager = module.Manager(FakeBackend(), Path(second))
            self.assertFalse(manager.read()["persisted"])
            with self.assertRaisesRegex(ValueError, "没有可还原"):
                manager.restore()

    def test_corrupt_state_does_not_overwrite_baseline(self):
        self.manager.state.parent.mkdir(parents=True)
        self.manager.state.write_text(json.dumps({"version": 2}))
        with self.assertRaisesRegex(RuntimeError, "备份损坏"):
            self.manager.apply(module.PRESET)
        self.assertEqual(self.backend.writes, [])


class LinuxBackendTests(unittest.TestCase):
    def backend(self):
        with patch.object(module.platform, "system", return_value="Linux"), patch.object(module.os, "geteuid", return_value=0, create=True), patch.object(module.shutil, "which", side_effect=lambda command: "/usr/sbin/" + command):
            return module.LinuxBackend()

    def test_unsupported_bbr_module_does_not_bypass_kernel_check(self):
        backend = self.backend()
        with patch.object(backend, "read", return_value="reno cubic"), patch.object(module.shutil, "which", return_value="/sbin/modprobe"), patch.object(module.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run:
            with self.assertRaisesRegex(ValueError, "不支持"):
                backend.prepare({"net.ipv4.tcp_congestion_control": "bbr"})
            self.assertEqual(run.call_args.args[0], ["/sbin/modprobe", "tcp_bbr"])

    def test_writes_use_argv_and_nonzero_status_is_an_error(self):
        backend = self.backend()
        with patch.object(module.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr="permission denied", stdout="")) as run:
            with self.assertRaisesRegex(RuntimeError, "permission denied"):
                backend.write("net.core.somaxconn", "2048")
            self.assertEqual(run.call_args.args[0], ["/usr/sbin/sysctl", "-w", "net.core.somaxconn=2048"])
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_missing_tc_does_not_block_parameter_management(self):
        backend = self.backend()
        with patch.object(module.shutil, "which", return_value=None):
            self.assertIn("未安装 tc", backend.qdiscs())


if __name__ == "__main__":
    unittest.main()
