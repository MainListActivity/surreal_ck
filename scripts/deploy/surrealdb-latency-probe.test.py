import contextlib
import copy
import importlib.util
import io
import json
import math
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('latency', Path(__file__).with_name('surrealdb-latency-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeExecutor:
    def __init__(self):
        self.calls = []
        self.databases = {'main': ['_system', 'platform_content', 'ignored'] + [f'ws_{n}' for n in range(7)],
                          'another': ['ws_00']}
        self.rows = [{'id': 'data:one', 'name': 'private-row-value', 'created': '2026-01-01'}]
        self.info = {'fields': {'name': 'DEFINE FIELD name ON data TYPE none | string PERMISSIONS FULL',
                                'created': 'DEFINE FIELD created ON data TYPE datetime;',
                                'nested.*.value': 'DEFINE FIELD nested.*.value ON data TYPE string;'},
                     'indexes': {'by_name': 'DEFINE INDEX by_name ON data FIELDS name UNIQUE;'}}
        self.fail = False

    def __call__(self, statement, namespace=None, database=None):
        self.calls.append((statement, namespace, database))
        if statement == 'INFO FOR ROOT;':
            return {'namespaces': {ns: f'DEFINE NAMESPACE {ns}' for ns in self.databases}}
        if statement == 'INFO FOR NS;':
            return {'databases': {db: f'DEFINE DATABASE {db}' for db in self.databases[namespace]}}
        if statement == 'INFO FOR DB;':
            return {'tables': {'data': 'DEFINE TABLE data SCHEMAFULL',
                               'view': 'DEFINE TABLE view AS\nSELECT * FROM data GROUP ALL;'}}
        if statement.startswith('INFO FOR TABLE'):
            return copy.deepcopy(self.info)
        if self.fail:
            raise RuntimeError('sensitive-server-error')
        if statement.startswith('SELECT count()'):
            return [{'count': len(self.rows)}]
        return copy.deepcopy(self.rows)

    def version(self):
        return 'surrealdb-3.3.0-native-quota.1'


class ProbeTests(unittest.TestCase):
    def make_report(self, **kwargs):
        return probe.sample(FakeExecutor(), workspace_limit=0, repetitions=1, **kwargs)

    def test_default_discovery_and_repetitions_are_read_only(self):
        execute = FakeExecutor()
        report = probe.sample(execute)
        self.assertTrue(report['complete'])
        self.assertEqual(report['scopes'], [{'ns': 'main', 'db': '_system'},
                         {'ns': 'main', 'db': 'platform_content'}, {'ns': 'main', 'db': 'ws_0'},
                         {'ns': 'another', 'db': 'ws_00'}, {'ns': 'main', 'db': 'ws_1'},
                         {'ns': 'main', 'db': 'ws_2'}, {'ns': 'main', 'db': 'ws_3'}])
        self.assertEqual(len(report['entries']), 21)
        for entry in report['entries']:
            self.assertEqual(len(entry['samples_ms']), 5)
            self.assertEqual(entry['status'], 'ok')
            self.assertEqual(entry['table'], 'data')
        self.assertEqual(len([s for s, _, _ in execute.calls if s.startswith('SELECT')]), 105)
        self.assertTrue(all(s.startswith(('INFO FOR ', 'SELECT ')) for s, _, _ in execute.calls))
        self.assertTrue(any('WITH INDEX `by_name` WHERE `name` = ' in s for s, _, _ in execute.calls))
        self.assertNotIn('private-row-value', json.dumps(report))
        self.assertNotIn('data:one', json.dumps(report))

    def test_statistics_include_round_trip_and_nearest_rank_p95(self):
        ticks = iter([0, .001, .01, .013, .02, .025, .03, .037, .04, .049])
        entry, _ = probe.measure(lambda *args: [], 'SELECT * FROM `t` LIMIT 50', 'main', '_system', 5, 30, lambda: next(ticks))
        self.assertAlmostEqual(entry['latency_ms']['p50'], 5)
        self.assertAlmostEqual(entry['latency_ms']['p95'], 9)
        self.assertAlmostEqual(entry['latency_ms']['max'], 9)

    def test_empty_rows_and_no_indexes_are_explicit_skips(self):
        for empty_rows in (True, False):
            execute = FakeExecutor()
            if empty_rows:
                execute.rows = []
            else:
                execute.info['indexes'] = {}
            report = probe.sample(execute, workspace_limit=0, repetitions=1)
            self.assertTrue(report['complete'])
            self.assertEqual([e['status'] for e in report['entries']], ['ok', 'ok', 'skipped'] * 2)

    def test_empty_inventory_and_missing_required_database_cannot_pass(self):
        execute = FakeExecutor()
        execute.databases = {}
        report = probe.sample(execute)
        self.assertFalse(report['complete'])
        self.assertEqual(report['issues'], ['missing_required_database', 'empty_inventory'])
        with self.assertRaises(probe.ProbeError):
            probe.compare(report, report, 2)

    def test_query_error_is_non_complete_and_redacted(self):
        execute = FakeExecutor()
        execute.fail = True
        report = probe.sample(execute, workspace_limit=0)
        self.assertFalse(report['complete'])
        self.assertEqual(report['entries'][0]['status'], 'error')
        self.assertEqual(report['entries'][0]['samples_ms'], [])
        self.assertNotIn('sensitive-server-error', json.dumps(report))

    def test_index_inference_is_conservative_and_literals_are_escaped(self):
        execute = FakeExecutor()
        for kind, value in [('string', '"; DELETE data; --\\\n'), ('bool', False), ('int', 123), ('number', 1.25),
                            ('option<string>', 'optional'), ('none | string', 'normalized'), ('none | null | int', 1)]:
            info = {'fields': {'name': f'DEFINE FIELD name ON data TYPE {kind};'},
                    'indexes': {'by_name': 'DEFINE INDEX by_name ON data COLUMNS name, other;'}}
            statement, details = probe.indexed_lookup('data', info, [{'name': value}])
            self.assertIn(' = ' + json.dumps(value, ensure_ascii=False), statement)
            self.assertEqual(details, {'index': 'by_name', 'field': 'name'})
        for definition in ['DEFINE INDEX idx ON data FIELDS name HNSW DIMENSION 3;',
                           'DEFINE INDEX idx ON data FIELDS nested.name;',
                           'DEFINE INDEX idx ON data FIELDS created;']:
            info = copy.deepcopy(execute.info)
            info['indexes'] = {'idx': definition}
            self.assertEqual(probe.indexed_lookup('data', info, execute.rows), (None, {}))

    def test_metadata_cannot_inject_statements(self):
        for value in ['foo`; DELETE data;', 'a.b', 'a\nb']:
            with self.assertRaises(probe.ProbeError):
                probe.identifier(value)
        with self.assertRaises(probe.ProbeError):
            probe.mapping({'tables': {'t': None}}, 'tables')

    def test_comparison_threshold_zero_and_worst_entries(self):
        before = self.make_report()
        for entry in before['entries']:
            entry['samples_ms'] = [1]
            entry['latency_ms'] = dict.fromkeys(probe.METRICS, 1)
        current = copy.deepcopy(before)
        for entry in current['entries']:
            entry['samples_ms'] = [2]
            entry['latency_ms'] = dict.fromkeys(probe.METRICS, 2)
        self.assertTrue(probe.compare(before, current, 2)['pass'])
        current['entries'][0]['latency_ms']['max'] = 3
        result = probe.compare(before, current, 2)
        self.assertFalse(result['pass'])
        self.assertEqual(result['exceeded_metrics'], 1)
        self.assertEqual(result['worst'][0]['kind'], 'count')
        self.assertEqual(result['worst'][0]['ratio'], 3)
        before['entries'][0]['latency_ms']['max'] = 0
        self.assertIsNone(probe.compare(before, current, 2)['worst'][0]['ratio'])

    def test_comparison_refuses_missing_queries_workload_and_status_changes(self):
        baseline = self.make_report()
        for mutation in ('missing', 'literal', 'settings', 'scopes', 'skipped'):
            current = copy.deepcopy(baseline)
            if mutation == 'missing':
                current['entries'].pop()
            elif mutation == 'literal':
                current['entries'][2]['statement_hash'] = 'changed'
            elif mutation == 'settings':
                current['settings']['timeout_s'] += 1
            elif mutation == 'scopes':
                current['scopes'].pop()
            else:
                current['entries'][2].update(status='skipped', reason='no_supported_index_value')
            self.assertFalse(probe.compare(baseline, current, 2)['pass'])

    def test_comparison_rejects_invalid_reports_and_ratios(self):
        baseline = self.make_report()
        for ratio in (0, -1, math.nan, math.inf):
            with self.assertRaises(probe.ProbeError):
                probe.compare(baseline, baseline, ratio)
        for mutation in ('duplicate', 'negative', 'nan', 'incomplete', 'samples'):
            current = copy.deepcopy(baseline)
            if mutation == 'duplicate':
                current['entries'].append(current['entries'][0])
            elif mutation in ('negative', 'nan'):
                current['entries'][0]['latency_ms']['p50'] = -1 if mutation == 'negative' else math.nan
            elif mutation == 'incomplete':
                current['complete'] = False
            else:
                current['entries'][0]['samples_ms'] = []
            with self.assertRaises(probe.ProbeError):
                probe.compare(baseline, current, 2)

    def test_http_is_fixed_loopback_no_redirect_and_hides_response_errors(self):
        connection = Mock()
        connection.getresponse.return_value = SimpleNamespace(status=200, read=lambda: b'[{"status":"OK","result":[]}]')
        with patch.object(probe, 'HTTPConnection', return_value=connection) as factory:
            execute = probe.Executor(('user', 'private-password'), 30)
            self.assertEqual(execute('INFO FOR DB;', 'main', '_system'), [])
            factory.assert_called_once_with('127.0.0.1', 8000, timeout=35)
            args, kwargs = connection.request.call_args
            self.assertEqual(args, ('POST', '/sql'))
            self.assertEqual(kwargs['body'], b'INFO FOR DB;')
            self.assertEqual(kwargs['headers']['surreal-db'], '_system')
            connection.close.assert_called_once()
            for status, body in [(302, b'private-password'), (200, b'[{"status":"ERR","result":"private-password"}]'), (200, b'private-password')]:
                connection.getresponse.return_value = SimpleNamespace(status=status, read=lambda: body)
                with self.assertRaises(probe.ProbeError) as raised:
                    execute('INFO FOR ROOT;')
                self.assertNotIn('private-password', str(raised.exception))

    def test_credentials_only_private_fixed_file_no_environment_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials'
            path.write_text('SURREAL_USER=root\nSURREAL_PASS="private password"\n')
            with patch.object(probe, 'ENV_FILE', path), patch.object(probe.os, 'geteuid', return_value=0), patch.object(probe.os, 'fstat') as fstat:
                fstat.return_value = SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)
                self.assertEqual(probe.credentials(), ('root', 'private password'))
                for uid, mode in [(1000, 0o600), (0, 0o640), (0, 0o622)]:
                    fstat.return_value = SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode)
                    with self.assertRaises(probe.ProbeError):
                        probe.credentials()
            with patch.object(probe.os, 'geteuid', return_value=1000):
                with self.assertRaises(probe.ProbeError):
                    probe.credentials()

    def test_cli_json_output_private_exclusive_file_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / 'baseline.json'
            with patch.object(probe, 'credentials', return_value=('root', 'private-password')), patch.object(probe, 'Executor', return_value=FakeExecutor()):
                self.assertEqual(probe.main(['sample', '--out', str(baseline), '--workspaces', '0', '--repeat', '1']), 0)
            self.assertEqual(stat.S_IMODE(baseline.stat().st_mode), 0o600)
            before = baseline.read_text()
            with self.assertRaises(FileExistsError):
                probe.write_report({}, str(baseline))
            self.assertEqual(before, baseline.read_text())
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(probe.main(['compare', str(baseline), str(baseline)]), 0)
            self.assertTrue(json.loads(output.getvalue())['pass'])
            self.assertNotIn('private-password', before + output.getvalue())
            current = Path(directory) / 'current.json'
            changed = json.loads(before)
            changed['entries'][0]['latency_ms']['max'] = 1e12
            current.write_text(json.dumps(changed))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(probe.main(['compare', str(baseline), str(current)]), 1)
            error = io.StringIO()
            baseline.write_text('private-password-invalid-json')
            with contextlib.redirect_stderr(error):
                self.assertEqual(probe.main(['compare', str(baseline), str(baseline)]), 2)
            self.assertNotIn('private-password', error.getvalue())


if __name__ == '__main__':
    unittest.main()
