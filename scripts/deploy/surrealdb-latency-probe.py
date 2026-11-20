#!/usr/bin/python3 -I
import argparse
import base64
from datetime import datetime, timezone
import hashlib
from http.client import HTTPConnection
import json
import math
import os
from pathlib import Path
import re
import shlex
import stat
import statistics
import sys
import time


ENV_FILE = Path('/etc/surrealdb/surrealdb.env')
IDENTIFIER = r'[A-Za-z_][A-Za-z0-9_]*'
METRICS = ('p50', 'p95', 'max')


class ProbeError(Exception):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(IDENTIFIER, value):
        raise ProbeError('unsupported_identifier')
    return '`' + value + '`'


def credentials():
    if os.geteuid() != 0:
        raise ProbeError('root_required')
    fd = os.open(ENV_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ProbeError('unsafe_credentials_file')
        values = {}
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            match = re.fullmatch(r'(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)', line)
            if not match:
                raise ProbeError('invalid_credentials_file')
            raw = match[2]
            parts = shlex.split(raw, comments=False) if raw.startswith(('"', "'")) else [raw]
            if len(parts) != 1:
                raise ProbeError('invalid_credentials_file')
            values[match[1]] = parts[0]
    user = values.get('SURREAL_USER') or values.get('SURREAL_ROOT_USER')
    password = values.get('SURREAL_PASS') or values.get('SURREAL_ROOT_PASS')
    if not user or not password or ':' in user:
        raise ProbeError('missing_root_credentials')
    return user, password


class Executor:
    def __init__(self, auth, timeout):
        self.authorization = 'Basic ' + base64.b64encode(':'.join(auth).encode()).decode()
        self.timeout = timeout

    def request(self, method, path, body=None, namespace=None, database=None):
        headers = {'Accept': 'application/json', 'Authorization': self.authorization,
                   'Content-Type': 'text/plain'}
        if namespace is not None:
            identifier(namespace)
            headers['surreal-ns'] = namespace
        if database is not None:
            identifier(database)
            headers['surreal-db'] = database
        connection = HTTPConnection('127.0.0.1', 8000, timeout=self.timeout + 5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            if response.status != 200:
                raise ProbeError('http_failed')
            return data
        except Exception:
            raise ProbeError('http_failed') from None
        finally:
            connection.close()

    def version(self):
        value = self.request('GET', '/version').decode().strip()
        if not re.fullmatch(r'surrealdb-[A-Za-z0-9.+_-]+', value):
            raise ProbeError('invalid_server_version')
        return value

    def __call__(self, statement, namespace=None, database=None):
        try:
            result = json.loads(self.request('POST', '/sql', statement.encode(), namespace, database))
            if (not isinstance(result, list) or len(result) != 1
                    or result[0].get('status') != 'OK' or 'result' not in result[0]):
                raise ProbeError('query_failed')
            return result[0]['result']
        except Exception:
            raise ProbeError('query_failed') from None


def mapping(info, key, validate_names=True):
    if not isinstance(info, dict) or not isinstance(info.get(key), dict):
        raise ProbeError('invalid_inventory')
    for name, definition in info[key].items():
        if validate_names:
            identifier(name)
        if not isinstance(definition, str):
            raise ProbeError('invalid_inventory')
    return info[key]


def scopes(execute, workspace_limit):
    found = []
    for ns in sorted(mapping(execute('INFO FOR ROOT;'), 'namespaces')):
        for db in sorted(mapping(execute('INFO FOR NS;', ns), 'databases')):
            found.append((ns, db))
    required = [scope for scope in found if scope[1] in ('_system', 'platform_content')]
    workspaces = sorted((scope for scope in found if scope[1].startswith('ws_')),
                        key=lambda scope: (scope[1], scope[0]))[:workspace_limit]
    return required + workspaces


def indexed_lookup(table, info, rows):
    fields = mapping(info, 'fields', validate_names=False)
    indexes = mapping(info, 'indexes')
    for index, definition in sorted(indexes.items()):
        match = re.search(r'\b(?:FIELDS|COLUMNS)\s+(`?' + IDENTIFIER + r'`?)(?=\s|,|;|$)', definition)
        if not match or re.search(r'\b(?:SEARCH|MTREE|HNSW|DISKANN|COUNT)\b', definition):
            continue
        field = match[1].strip('`')
        field_type = re.search(r'\bTYPE\s+(.+?)(?=\s+(?:DEFAULT|READONLY|VALUE|ASSERT|PERMISSIONS|REFERENCE|COMPUTED)\b|;|$)', fields.get(field, ''))
        if not field_type:
            continue
        expression = field_type[1].strip()
        optional = re.fullmatch(r'option<\s*(.*?)\s*>', expression)
        kinds = {part.strip() for part in (optional[1] if optional else expression).split('|')} - {'none', 'null'}
        if len(kinds) != 1 or not kinds.issubset({'string', 'int', 'float', 'number', 'bool'}):
            continue
        kind = next(iter(kinds))
        values = [row[field] for row in rows if isinstance(row, dict) and field in row]
        values = [value for value in values if
                  (kind == 'string' and isinstance(value, str)) or
                  (kind == 'bool' and type(value) is bool) or
                  (kind == 'int' and type(value) is int) or
                  (kind in ('float', 'number') and type(value) in (int, float) and math.isfinite(value))]
        if not values:
            continue
        value = min(values)
        literal = json.dumps(value, ensure_ascii=False, allow_nan=False)
        statement = (f'SELECT * FROM {identifier(table)} WITH INDEX {identifier(index)} '
                     f'WHERE {identifier(field)} = {literal} LIMIT 50')
        return statement, {'index': index, 'field': field}
    return None, {}


def measure(execute, statement, ns, db, repetitions, timeout, clock):
    statement += f' TIMEOUT {timeout}s;'
    entry = {'status': 'ok', 'statement_hash': hashlib.sha256(statement.encode()).hexdigest()}
    samples = []
    result = None
    for _ in range(repetitions):
        start = clock()
        try:
            result = execute(statement, ns, db)
        except Exception:
            entry.update(status='error', reason='query_failed')
            break
        samples.append((clock() - start) * 1000)
    entry['samples_ms'] = samples
    entry['latency_ms'] = ({'p50': statistics.median(samples),
                            'p95': sorted(samples)[math.ceil(len(samples) * 0.95) - 1],
                            'max': max(samples)} if samples else None)
    return entry, result


def sample(execute, workspace_limit=5, repetitions=5, timeout=30, clock=time.perf_counter):
    selected = scopes(execute, workspace_limit)
    report = {'format_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
              'settings': {'workspace_limit': workspace_limit, 'repetitions': repetitions,
                           'timeout_s': timeout, 'sample_limit': 50},
              'scopes': [{'ns': ns, 'db': db} for ns, db in selected],
              'issues': [], 'entries': []}
    if not {'_system', 'platform_content'}.issubset({db for _, db in selected}):
        report['issues'].append('missing_required_database')
    for ns, db in selected:
        tables = mapping(execute('INFO FOR DB;', ns, db), 'tables')
        for table, definition in sorted(tables.items()):
            if re.search(r'\bAS\s+(?:SELECT|\(\s*SELECT)\b', definition, re.IGNORECASE):
                continue
            identity = {'ns': ns, 'db': db, 'table': table}
            statements = [('count', f'SELECT count() FROM {identifier(table)} GROUP ALL'),
                          ('sample', f'SELECT * FROM {identifier(table)} LIMIT 50')]
            rows = None
            for kind, statement in statements:
                entry, result = measure(execute, statement, ns, db, repetitions, timeout, clock)
                report['entries'].append({**identity, 'kind': kind, **entry})
                if kind == 'sample' and entry['status'] == 'ok':
                    if not isinstance(result, list) or not all(isinstance(row, dict) for row in result):
                        raise ProbeError('invalid_sample_result')
                    rows = result
            entry = {**identity, 'kind': 'index_lookup'}
            info = execute(f'INFO FOR TABLE {identifier(table)};', ns, db)
            statement, details = indexed_lookup(table, info, rows or [])
            if statement is None:
                entry.update(status='skipped', reason='no_supported_index_value' if rows else 'empty_or_unavailable_sample')
            else:
                measured, _ = measure(execute, statement, ns, db, repetitions, timeout, clock)
                entry.update(**details, **measured)
            report['entries'].append(entry)
    if not report['entries']:
        report['issues'].append('empty_inventory')
    report['complete'] = not report['issues'] and all(entry['status'] != 'error' for entry in report['entries'])
    return report


def validated_entries(report):
    if (report.get('format_version') != 1 or report.get('complete') is not True
            or report.get('issues') != [] or not report.get('entries')):
        raise ProbeError('incomplete_report')
    entries = {}
    for entry in report['entries']:
        key = tuple(entry[name] for name in ('ns', 'db', 'table', 'kind'))
        if key in entries or entry['status'] not in ('ok', 'skipped'):
            raise ProbeError('invalid_report_entry')
        if entry['status'] == 'ok':
            samples = entry['samples_ms']
            if (len(samples) != report['settings']['repetitions']
                    or not all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in samples)):
                raise ProbeError('invalid_report_samples')
            for metric in METRICS:
                value = entry['latency_ms'][metric]
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise ProbeError('invalid_report_latency')
        entries[key] = entry
    return entries


def compare(baseline, current, max_ratio):
    if not math.isfinite(max_ratio) or max_ratio <= 0:
        raise ProbeError('invalid_max_ratio')
    before, after = validated_entries(baseline), validated_entries(current)
    issues = []
    if baseline['settings'] != current['settings'] or baseline['scopes'] != current['scopes']:
        issues.append('selection_or_settings_changed')
    if before.keys() != after.keys():
        issues.append('query_coverage_changed')
    worst = []
    for key in sorted(before.keys() & after.keys()):
        old, new = before[key], after[key]
        identity = dict(zip(('ns', 'db', 'table', 'kind'), key))
        if any(old.get(name) != new.get(name) for name in ('status', 'reason', 'statement_hash', 'index', 'field')):
            issues.append({**identity, 'reason': 'query_or_skip_changed'})
            continue
        if old['status'] == 'skipped':
            continue
        for metric in METRICS:
            a, b = old['latency_ms'][metric], new['latency_ms'][metric]
            ratio = b / a if a else (1.0 if b == 0 else None)
            worst.append({**identity, 'metric': metric, 'baseline_ms': a, 'current_ms': b,
                          'ratio': ratio, 'exceeded': ratio is None or ratio > max_ratio})
    worst.sort(key=lambda entry: float('inf') if entry['ratio'] is None else entry['ratio'], reverse=True)
    exceeded = sum(entry['exceeded'] for entry in worst)
    return {'pass': not issues and not exceeded, 'max_ratio': max_ratio, 'issues': issues,
            'exceeded_metrics': exceeded, 'compared_metrics': len(worst), 'worst': worst[:20]}


def write_report(report, destination):
    value = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    if destination is None:
        sys.stdout.write(value)
    else:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(value)


def positive(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError('必须为正整数')
    return result


def nonnegative(value):
    result = int(value)
    if result < 0:
        raise argparse.ArgumentTypeError('不能为负数')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='仅 loopback HTTP /sql 的只读维护延迟探针')
    subparsers = parser.add_subparsers(dest='command', required=True)
    probe = subparsers.add_parser('sample')
    probe.add_argument('--workspaces', type=nonnegative, default=5)
    probe.add_argument('--repeat', type=positive, default=5)
    probe.add_argument('--timeout', type=positive, default=30)
    probe.add_argument('--out')
    comparison = subparsers.add_parser('compare')
    comparison.add_argument('baseline', type=Path)
    comparison.add_argument('current', type=Path)
    comparison.add_argument('--max-ratio', type=float, default=2.0)
    comparison.add_argument('--out')
    args = parser.parse_args(argv)
    try:
        if args.command == 'sample':
            executor = Executor(credentials(), args.timeout)
            version = executor.version()
            report = sample(executor, args.workspaces, args.repeat, args.timeout)
            report['server_version'] = version
            passed = report['complete']
        else:
            report = compare(json.loads(args.baseline.read_text()), json.loads(args.current.read_text()), args.max_ratio)
            passed = report['pass']
        write_report(report, args.out)
        return 0 if passed else 1
    except Exception:
        sys.stderr.write('延迟探针失败：请检查 root 权限、私有凭证文件、数据库响应或报告结构；错误详情与数据不输出。\n')
        return 2


if __name__ == '__main__':
    sys.exit(main())
