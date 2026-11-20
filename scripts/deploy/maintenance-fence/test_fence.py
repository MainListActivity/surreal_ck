import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("fence", Path(__file__).with_name("sck_maintenance_fence.py"))
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)

ORIGINAL = b'''# synthetic fixture only; a comment with { }
other.example {
    handle { respond "other { unchanged }" }
}
data.maplayer.top {
    handle /__company_owner/* {
        reverse_proxy 127.0.0.1:9001
    }
    handle /__surreal_ck_hono/* {
        reverse_proxy 127.0.0.1:8080
    }
    handle /sck-mcp/* {
        reverse_proxy 127.0.0.1:9002
    }
    handle /internal-ai/status {
        respond `{"status":"fixture"}`
    }
    handle /ofm/* {
        reverse_proxy 127.0.0.1:9003
    }
    handle {
        header X-Fixture {$FIXTURE_HEADER}
        reverse_proxy 127.0.0.1:8000 {
            header_up X-Fixture "fixture # { }"
        }
    } # retain this comment
}
'''


class RewriteTests(unittest.TestCase):
    def test_only_the_database_fallback_changes(self):
        prefix, remainder = ORIGINAL.rsplit(b"    handle {", 1)
        expected = prefix + b"    handle {\n        respond 503\n    } # retain this comment\n}\n"
        self.assertEqual(fence.fenced_config(ORIGINAL), expected)
        self.assertIn(b"127.0.0.1:8000", remainder)

    def test_missing_ambiguous_nonfinal_or_unexpected_upstream_refuses(self):
        fixtures = [b"", ORIGINAL.replace(b"data.maplayer.top", b"missing.example"), ORIGINAL + ORIGINAL,
                    ORIGINAL.replace(b"127.0.0.1:8000", b"127.0.0.1:8001"),
                    ORIGINAL.replace(b"127.0.0.1:8000 {", b"127.0.0.1:8000 127.0.0.1:8001 {"),
                    ORIGINAL.replace(b"} # retain this comment", b"}\n    handle /late { respond 200 }"),
                    ORIGINAL.replace(b"} # retain this comment", b"}\n    handle { respond 200 }"),
                    ORIGINAL.replace(b"fixture # { }", b"unterminated")[:-10],
                    ORIGINAL.replace(b"header X-Fixture {$FIXTURE_HEADER}", b"respond <<EOF\nx\nEOF")]
        for source in fixtures:
            with self.subTest(source=source[:30]), self.assertRaises((RuntimeError, UnicodeError)):
                fence.fenced_config(source)

    def test_connection_check_covers_external_ipv4_ipv6_and_caddy_streams(self):
        self.assertTrue(fence.connections_closed(""))
        self.assertTrue(fence.connections_closed("0 0 127.0.0.1:8000 127.0.0.1:4000\n"))
        self.assertTrue(fence.connections_closed("0 0 [::1]:8000 [::ffff:127.0.0.1]:4000\n"))
        self.assertFalse(fence.connections_closed("0 0 10.0.0.1:8000 198.51.100.1:4000\n"))
        self.assertFalse(fence.connections_closed("0 0 [::]:8000 [2001:db8::1]:4000\n"))
        self.assertFalse(fence.connections_closed('0 0 127.0.0.1:4000 127.0.0.1:8000 users:(("caddy",pid=1,fd=2))\n'))
        with self.assertRaises(RuntimeError):
            fence.connections_closed("unexpected output")

    def test_world_writable_or_symlink_paths_are_not_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unsafe"
            path.write_text("fixture")
            path.chmod(0o666)
            with self.assertRaises(RuntimeError):
                fence.secure(path)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(RuntimeError):
                fence.secure(link)

    def test_alternatives_binary_keeps_iptables_argv_zero(self):
        with patch.object(fence, "executable", return_value="/fixture/xtables-nft-multi"), \
                patch.object(fence.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            fence.command("/usr/sbin/iptables", "--wait", "10")
        self.assertEqual(run.call_args.args[0], ("/usr/sbin/iptables", "--wait", "10"))
        self.assertEqual(run.call_args.kwargs["executable"], "/fixture/xtables-nft-multi")

    def test_origin_health_uses_loopback_without_redirects_or_proxy_and_checks_json(self):
        for status, payload, healthy in [(200, b'{"status":"ok","surrealdb":"up"}', True),
                                         (200, b'{"status":"ok","surrealdb":"down"}', False),
                                         (200, b'', False), (302, b'{}', False)]:
            response = io.BytesIO(payload)
            response.status = status
            with patch.object(fence, "HTTPConnection") as factory, patch.object(fence, "command"):
                connection = factory.return_value
                connection.getresponse.return_value = response
                if healthy:
                    fence.origin_ready()
                else:
                    with self.assertRaises((RuntimeError, ValueError)):
                        fence.origin_ready()
                factory.assert_called_once_with("127.0.0.1", 8080, timeout=5)
                connection.request.assert_called_once_with("GET", "/health")
                connection.close.assert_called_once()


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "Caddyfile"
        self.config.write_bytes(ORIGINAL)
        self.config.chmod(0o600)
        self.state = self.root / "state"
        self.calls, self.rules, self.running = [], set(), set()
        self.ss_output = ""
        self.fail_validate = self.fail_reload = self.fail_firewall = False
        stack = ExitStack()
        self.addCleanup(stack.close)
        for name, value in (("CONFIG", self.config), ("STATE", self.state)):
            stack.enter_context(patch.object(fence, name, value))
        stack.enter_context(patch.object(fence, "secure"))
        stack.enter_context(patch.object(fence, "secure_parents"))
        stack.enter_context(patch.object(fence, "executable", side_effect=lambda path: path))
        stack.enter_context(patch.object(fence.os, "geteuid", return_value=0))
        stack.enter_context(patch.object(fence.os, "fchown"))
        stack.enter_context(patch.object(fence.time, "sleep"))
        self.ready = stack.enter_context(patch.object(fence, "origin_ready"))
        stack.enter_context(patch.object(fence, "command", side_effect=self.command))

    def command(self, *args, allowed=(0,)):
        self.calls.append(args)
        code, output = 0, ""
        if args[0] == fence.SYSTEMCTL:
            if args[1] == "stop":
                self.running.difference_update(args[2:])
            elif args[1] == "start":
                self.running.update(args[2:])
            elif args[1] == "is-active":
                code = 0 if args[-1] in self.running else 3
            elif args[1] == "reload" and self.fail_reload:
                raise RuntimeError("fixture reload failure")
        elif args[0] == fence.CADDY and self.fail_validate:
            raise RuntimeError("fixture validation failure")
        elif args[0] in fence.FIREWALLS:
            if self.fail_firewall:
                raise RuntimeError("fixture firewall failure")
            if "-C" in args:
                code = 0 if args[0] in self.rules else 1
            elif "-I" in args:
                self.rules.add(args[0])
            elif "-D" in args:
                self.rules.remove(args[0])
        elif args[0] == fence.SS:
            output = self.ss_output
        if code not in allowed:
            raise RuntimeError("fixture command failed")
        return subprocess.CompletedProcess(args, code, output, "")

    def test_idempotent_fence_and_unfence_preserve_backup_and_origin_lifecycle(self):
        fence.operate("fence")
        record = json.loads((self.state / "state.json").read_text())
        backup = self.state / record["session"] / "original.Caddyfile"
        self.assertEqual(backup.read_bytes(), ORIGINAL)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.config.read_bytes(), fence.fenced_config(ORIGINAL))
        fence.operate("fence")
        self.assertEqual(len(list(self.state.glob("session-*"))), 1)
        self.assertEqual(len([call for call in self.calls if "-I" in call]), 2)
        self.assertEqual(self.rules, set(fence.FIREWALLS))
        self.assertLess(next(i for i, call in enumerate(self.calls) if call[0] == fence.CADDY),
                        self.calls.index((fence.SYSTEMCTL, "reload", "caddy.service")))
        fence.operate("unfence")
        fence.operate("unfence")
        self.assertEqual(self.config.read_bytes(), ORIGINAL)
        self.assertEqual(backup.read_bytes(), ORIGINAL)
        self.assertFalse(self.rules)
        self.assertIn(fence.MCP, self.running)
        self.assertNotIn((fence.SYSTEMCTL, "start", fence.ORIGIN), self.calls)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)

    def test_new_cycle_snapshots_the_current_configuration(self):
        fence.operate("fence")
        fence.operate("unfence")
        revised = ORIGINAL + b"# legitimate later change\n"
        self.config.write_bytes(revised)
        fence.operate("fence")
        record = json.loads((self.state / "state.json").read_text())
        self.assertEqual((self.state / record["session"] / "original.Caddyfile").read_bytes(), revised)
        self.assertEqual(len(list(self.state.glob("session-*"))), 2)

    def test_validation_failure_restores_file_without_reload(self):
        self.fail_validate = True
        with self.assertRaises(RuntimeError):
            fence.operate("fence")
        self.assertEqual(self.config.read_bytes(), ORIGINAL)
        self.assertNotIn((fence.SYSTEMCTL, "reload", "caddy.service"), self.calls)
        self.assertFalse(self.rules)

    def test_reload_or_firewall_failure_never_claims_success_or_restarts_writers(self):
        for failure in ("fail_reload", "fail_firewall"):
            setattr(self, failure, True)
            with self.assertRaises(RuntimeError):
                fence.operate("fence")
            setattr(self, failure, False)
            self.assertNotIn(fence.MCP, self.running)
            self.assertNotIn(fence.ORIGIN, self.running)

    def test_external_connection_prevents_verified_fence(self):
        self.ss_output = "0 0 10.0.0.1:8000 198.51.100.1:50000\n"
        with self.assertRaisesRegex(RuntimeError, "connections remain"):
            fence.operate("fence")
        self.assertEqual(self.rules, set(fence.FIREWALLS))
        self.assertEqual(self.config.read_bytes(), fence.fenced_config(ORIGINAL))

    def test_configuration_drift_is_never_overwritten(self):
        fence.operate("fence")
        changed = self.config.read_bytes() + b"# concurrent edit\n"
        self.config.write_bytes(changed)
        for mode in ("fence", "unfence"):
            with self.assertRaisesRegex(RuntimeError, "operator review"):
                fence.operate(mode)
            self.assertEqual(self.config.read_bytes(), changed)

    def test_unhealthy_origin_or_invalid_restore_retains_firewall_and_stopped_mcp(self):
        fence.operate("fence")
        self.ready.side_effect = RuntimeError("fixture origin down")
        with self.assertRaises(RuntimeError):
            fence.operate("unfence")
        self.ready.side_effect = None
        self.fail_validate = True
        with self.assertRaises(RuntimeError):
            fence.operate("unfence")
        self.assertEqual(self.config.read_bytes(), fence.fenced_config(ORIGINAL))
        self.assertEqual(self.rules, set(fence.FIREWALLS))
        self.assertNotIn(fence.MCP, self.running)

    def test_missing_session_refuses_unfence_and_error_output_is_redacted(self):
        output = io.StringIO()
        with redirect_stderr(output), self.assertRaises(SystemExit):
            fence.main("unfence")
        self.assertNotIn("fixture", output.getvalue())
        self.assertFalse(self.calls)
        with patch.object(fence, "operate", side_effect=RuntimeError("synthetic-private-marker")), \
                redirect_stderr(output), self.assertRaises(SystemExit):
            fence.main("fence")
        self.assertNotIn("synthetic-private-marker", output.getvalue())

    def test_non_root_cannot_read_config_or_change_services(self):
        with patch.object(fence.os, "geteuid", return_value=1000), self.assertRaisesRegex(RuntimeError, "root"):
            fence.operate("fence")
        self.assertFalse(self.calls)
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
