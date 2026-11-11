"""静态契约检查，不安装或启动 Windows 应用，也不构成运行证据。"""
from pathlib import Path
import shutil
import subprocess
import unittest

SCRIPT = Path(__file__).with_name('windows-install-smoke.ps1')


class WindowsSmokeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SCRIPT.read_text(encoding='utf-8')

    def test_requires_exact_artifact_and_both_receipts(self):
        for name in ('SetupPath', 'PackageEvidencePath', 'BuildReceiptPath', 'EvidenceDir'):
            self.assertIn('[Parameter(Mandatory)][string]$' + name, self.source)
        for check in ('$receipt.filename -ne $setup.Name', '$receipt.size -ne $setup.Length',
                      '$receipt.sha256 -ne $setupHash',
                      '$installedHash -ne $package.packaged_executable_sha256'):
            self.assertIn(check, self.source)

    def test_refuses_production_before_installing(self):
        guard = self.source.index("$document.update_config -ne 'absent-blocked'")
        install = self.source.index('Start-Process -FilePath $setup.FullName')
        self.assertLess(guard, install)
        self.assertIn('$null -ne $document.update_config_public', self.source)
        self.assertNotIn('-Verb RunAs', self.source)
        self.assertNotIn('Set-ExecutionPolicy', self.source)

    def test_real_observation_and_window_required(self):
        self.assertIn('[ValidateRange(20, 300)]', self.source)
        self.assertIn('while ($timer.Elapsed.TotalSeconds -lt $ObserveSeconds)', self.source)
        self.assertIn('[SmokeWindow]::IsWindowVisible($app.MainWindowHandle)', self.source)
        self.assertIn('No responsive visible application window', self.source)
        self.assertIn('Application exited early', self.source)
        self.assertLess(self.source.index("$result.gui = 'visible-responsive-window'"),
                        self.source.index("$result.status = 'passed'"))

    def test_failure_and_scope_are_explicit(self):
        for marker in ("status = 'failed'", "permissions_granted_by_test = $false",
                       "update_gate_bypassed = $false", "release_eligible = $false",
                       "login_chat_meeting_files_update = 'not-run'", 'smoke-result.json',
                       "if ($result.status -ne 'passed') { throw"):
            self.assertIn(marker, self.source)
        self.assertIn('application-events.txt', self.source)
        self.assertIn('application-window.png', self.source)
        self.assertIn('app/unins000.exe', self.source)

    @unittest.skipUnless(shutil.which('pwsh'), 'PowerShell unavailable; syntax parse not run')
    def test_powershell_parser_when_available(self):
        command = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }"
        # Supply script path via environment to avoid command-line quoting ambiguities.
        import os
        command = command.replace('$args[0]', '$env:SMOKE_SCRIPT')
        run = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                             env=os.environ | {'SMOKE_SCRIPT': str(SCRIPT.resolve())},
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


if __name__ == '__main__':
    unittest.main()
