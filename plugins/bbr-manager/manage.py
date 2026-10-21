#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 ForwardX contributors
"""ForwardX TCP sysctl manager. Standard library only; never executes config as code."""
import base64
import contextlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

PRESET = "net.core.default_qdisc = fq\nnet.ipv4.tcp_congestion_control = bbr\n"
CORE_KEYS = set("default_qdisc somaxconn rmem_max wmem_max rmem_default wmem_default optmem_max netdev_max_backlog netdev_budget netdev_budget_usecs".split())
GUI_KEYS = "net.ipv4.tcp_congestion_control net.core.default_qdisc net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max net.ipv4.tcp_mtu_probing net.ipv4.tcp_fastopen net.ipv4.tcp_slow_start_after_idle net.ipv4.tcp_no_metrics_save net.core.somaxconn net.core.netdev_max_backlog".split()


def supported(key):
    return bool(re.fullmatch(r"net\.ipv4\.tcp_[a-z0-9_]+", key)) or key.startswith("net.core.") and key[9:] in CORE_KEYS


def normalize(value):
    return " ".join(value.split())


def parse(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 12000:
        raise ValueError("配置必须为文本且不能超过 12000 字节")
    entries = {}
    for index, line in enumerate(text.split("\n"), 1):
        clean = line.split("#", 1)[0].strip()
        if not clean or clean.startswith(";"):
            continue
        match = re.fullmatch(r"([a-z0-9_.]+)\s*=\s*([a-zA-Z0-9_.:/+ \t-]+)", clean)
        if not match or not supported(match[1]) or not match[2].strip():
            raise ValueError("第 %d 行不是受支持的 TCP / 队列参数" % index)
        if match[1] in entries:
            raise ValueError("第 %d 行参数重复：%s" % (index, match[1]))
        entries[match[1]] = normalize(match[2])
    if not entries:
        raise ValueError("请至少填写一个参数")
    return entries


def atomic_write(path, data):
    """Replace a plugin-owned file without ever truncating its previous contents."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=".forwardx-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # sysctl.d is read by root, so 0600 is intentional.
        os.replace(name, path)
        if os.name == "posix":
            directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class LinuxBackend:
    def __init__(self):
        if platform.system() != "Linux":
            raise RuntimeError("此插件仅支持 Linux Agent")
        if os.geteuid() != 0:
            raise RuntimeError("请以 root 权限运行 Agent")
        self.sysctl = shutil.which("sysctl")
        if not self.sysctl:
            raise RuntimeError("未找到 sysctl，请安装 procps / procps-ng")

    def read(self, key):
        if not supported(key) and key != "net.ipv4.tcp_available_congestion_control":
            raise ValueError("不支持的参数：" + key)
        return normalize(Path("/proc/sys", key.replace(".", "/")).read_text().strip())

    def write(self, key, value):
        result = subprocess.run([self.sysctl, "-w", key + "=" + value], capture_output=True, text=True, timeout=5)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout).strip() or "sysctl 写入失败")

    def prepare(self, entries):
        module = shutil.which("modprobe")
        algorithm = entries.get("net.ipv4.tcp_congestion_control")
        if algorithm and algorithm not in self.read("net.ipv4.tcp_available_congestion_control").split():
            if module and algorithm in ("bbr", "bbr2", "bbr3", "cubic"):
                subprocess.run([module, "tcp_" + algorithm], capture_output=True, timeout=5)
            if algorithm not in self.read("net.ipv4.tcp_available_congestion_control").split():
                raise ValueError("当前内核不支持拥塞控制算法：" + algorithm)
        queue = entries.get("net.core.default_qdisc")
        if module and queue in ("fq", "fq_codel", "cake"):
            subprocess.run([module, "sch_" + queue], capture_output=True, timeout=5)

    def qdiscs(self):
        tc = shutil.which("tc")
        if not tc:
            return "未安装 tc，无法读取现有队列"
        try:
            result = subprocess.run([tc, "-j", "qdisc", "show"], capture_output=True, text=True, timeout=5)
            if result.returncode:
                return "现有队列读取失败"
            rows = json.loads(result.stdout)
            return "; ".join("%s: %s" % (row.get("dev", "?"), row.get("kind", "?")) for row in rows) or "暂无队列"
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return "现有队列读取失败"


class Manager:
    def __init__(self, backend, root=Path("/")):
        self.backend = backend
        self.conf = root / "etc/sysctl.d/90-forwardx-bbr.conf"
        self.state_dir = root / "var/lib/forwardx-agent/plugin-state/bbr-manager"
        self.state = self.state_dir / "original.json"

    @staticmethod
    def file_bytes(path):
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None

    @staticmethod
    def replace_file(path, content):
        if content is None:
            path.unlink(missing_ok=True)
        else:
            atomic_write(path, content)

    def load_state(self):
        raw = self.file_bytes(self.state)
        if raw is None:
            return None
        state = json.loads(raw)
        if state.get("version") != 1 or not isinstance(state.get("values"), dict) or not isinstance(state.get("managedKeys"), list):
            raise RuntimeError("原参数备份损坏，停止操作以免覆盖")
        if "originalConfig" not in state or state["originalConfig"] is not None and not isinstance(state["originalConfig"], str):
            raise RuntimeError("原参数备份损坏，停止操作以免覆盖")
        for key, value in state["values"].items():
            if not supported(key) or not isinstance(value, str):
                raise RuntimeError("原参数备份包含不支持的参数")
        if any(key not in state["values"] for key in state["managedKeys"]):
            raise RuntimeError("原参数备份缺少已托管参数")
        return state

    def save_state(self, state):
        atomic_write(self.state, json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8"))

    def read(self):
        saved = self.file_bytes(self.conf)
        saved_text = saved.decode("utf-8") if saved is not None else ""
        values = {}
        saved_entries = parse(saved_text) if saved_text.strip() else {}
        for key in dict.fromkeys(GUI_KEYS + list(saved_entries)):
            try:
                values[key] = self.backend.read(key)
            except FileNotFoundError:
                continue
        runtime_text = "".join("%s = %s\n" % (key, value) for key, value in values.items())
        # Use the saved selection/comments, but show fresh kernel values in the editor.
        # A drifted saved value remains separately visible in savedConfigText.
        if saved_text:
            lines = []
            for line in saved_text.splitlines():
                key = line.split("#", 1)[0].strip().split("=", 1)[0].strip()
                if key in values:
                    comment = " #" + line.split("#", 1)[1] if "#" in line else ""
                    line = "%s = %s%s" % (key, values[key], comment)
                lines.append(line)
            config = "\n".join(lines) + "\n"
        else:
            config = "".join("%s = %s\n" % (key, values[key]) for key in GUI_KEYS[:2] if key in values)
        return {"id": "kernel", "name": "TCP / BBR", "kernel": platform.release(),
                "congestionControl": values.get(GUI_KEYS[0], "不支持"),
                "defaultQdisc": values.get(GUI_KEYS[1], "不支持"),
                "availableAlgorithms": self.backend.read("net.ipv4.tcp_available_congestion_control"),
                "currentQueues": self.backend.qdiscs(), "persisted": saved is not None,
                "inSync": bool(saved_entries) and all(values.get(key) == value for key, value in saved_entries.items()),
                "configText": config, "runtimeText": runtime_text, "savedConfigText": saved_text,
                "canRestore": self.state.exists()}

    def transaction(self, targets, config_bytes, journal, final_state):
        before = {key: self.backend.read(key) for key in targets}
        old_config = self.file_bytes(self.conf)
        old_state = self.file_bytes(self.state)
        attempted = []
        # Durable baseline is stored outside the replaceable plugin asset directory.
        self.save_state(journal)
        try:
            for key, value in targets.items():
                if before[key] != normalize(value):
                    attempted.append(key)  # also undo a command that failed after changing a value
                    self.backend.write(key, value)
                if self.backend.read(key) != normalize(value):
                    raise RuntimeError("参数校验失败：" + key)
            self.replace_file(self.conf, config_bytes)
            if final_state is None:
                self.state.unlink()
            else:
                self.save_state(final_state)
        except Exception as error:
            failures = []
            for key in reversed(attempted):
                try:
                    self.backend.write(key, before[key])
                    if self.backend.read(key) != before[key]:
                        raise RuntimeError("回滚校验失败")
                except Exception as rollback_error:
                    failures.append("%s: %s" % (key, rollback_error))
            try:
                self.replace_file(self.conf, old_config)
            except Exception as rollback_error:
                failures.append("配置文件: " + str(rollback_error))
            if not failures:
                try:
                    self.replace_file(self.state, old_state)
                except Exception as rollback_error:
                    failures.append("备份文件: " + str(rollback_error))
            if failures:
                raise RuntimeError("操作失败：%s；部分回滚失败（保留原参数备份，请重试还原）：%s" % (error, "; ".join(failures))) from error
            raise RuntimeError("操作失败，已回滚：" + str(error)) from error

    def apply(self, text):
        entries = parse(text)
        self.backend.prepare(entries)
        previous = self.load_state()
        if previous is None:
            original_config = self.file_bytes(self.conf)
            previous = {"version": 1, "values": {}, "managedKeys": [],
                        "originalConfig": base64.b64encode(original_config).decode("ascii") if original_config is not None else None}
        journal = json.loads(json.dumps(previous))
        for key in entries:
            if key not in journal["values"]:
                journal["values"][key] = self.backend.read(key)
        targets = {key: journal["values"][key] for key in previous["managedKeys"] if key not in entries}
        targets.update(entries)
        journal["managedKeys"] = list(dict.fromkeys(previous["managedKeys"] + list(entries)))
        final_state = {**journal, "managedKeys": list(entries)}
        # Store normalized syntax, retaining the user's comments and order.
        persisted = "\n".join(text.replace("\r\n", "\n").splitlines()) + "\n"
        self.transaction(targets, persisted.encode("utf-8"), journal, final_state)
        return {"id": "kernel", "message": "已应用并保存；新 TCP 连接使用新算法。默认队列不强制替换现有网卡队列。"}

    def restore(self):
        state = self.load_state()
        if state is None:
            raise ValueError("没有可还原的插件修改记录")
        config = state.get("originalConfig")
        original = base64.b64decode(config, validate=True) if config is not None else None
        targets = {key: state["values"][key] for key in state["managedKeys"]}
        self.backend.prepare(targets)
        self.transaction(targets, original, state, None)
        return {"id": "kernel", "message": "已还原插件修改前的参数和插件配置文件；未修改其他 sysctl 文件。"}


@contextlib.contextmanager
def locked(manager, write=True):
    import fcntl
    manager.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (manager.state_dir / "lock").open("a") as stream:
        try:
            fcntl.flock(stream, (fcntl.LOCK_EX if write else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("该主机正在执行 BBR 管理操作，请稍后重试") from None
        yield


def main():
    manager = Manager(LinuxBackend())
    command = sys.argv[1] if len(sys.argv) > 1 else "list"
    with locked(manager, write=command not in ("list", "read")):
        if command == "list":
            detail = manager.read()
            result = {"items": [{key: value for key, value in detail.items() if key not in ("configText", "runtimeText", "savedConfigText")}]}
        elif command == "read":
            result = manager.read()
        elif command == "apply":
            result = manager.apply(sys.argv[2])
        elif command == "preset":
            result = manager.apply(PRESET)
        elif command == "restore":
            result = manager.restore()
        else:
            raise ValueError("未知操作")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("BBR 管理失败：" + str(error), file=sys.stderr)
        sys.exit(1)
