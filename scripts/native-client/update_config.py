"""Offline validation of the public EmbeddedConfig contract in native-updater.
Stricter publication checks also require this app ID, usable host lists, and a
safe relative Linux executable. No service availability or key ownership claim.
"""
import json
import pathlib
import re
import urllib.parse

APP_ID = 'top.maplayer.collaboration'

def validate_config(value):
    if not isinstance(value, dict) or set(value) != {'trust','policy_urls','network_hosts','linux_executable'}:
        raise ValueError('Invalid EmbeddedConfig fields')
    trust = value['trust']
    if not isinstance(trust, dict) or set(trust) != {'public_key','app_id','channel','download_hosts'}:
        raise ValueError('Invalid TrustConfig fields')
    key = trust['public_key']
    if not isinstance(key, list) or len(key) != 32 or any(type(b) is not int or not 0 <= b <= 255 for b in key) or not any(key):
        raise ValueError('Public key must be 32 nonzero-key bytes (not a placeholder zero key)')
    if trust['app_id'] != APP_ID or not isinstance(trust['channel'], str) or not trust['channel'].strip():
        raise ValueError('Wrong application ID or empty channel')
    for hosts in (value['network_hosts'], trust['download_hosts']):
        if not isinstance(hosts, list) or not hosts:
            raise ValueError('Host allowlist must not be empty')
        for host in hosts:
            if not isinstance(host, str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host) or '..' in host:
                raise ValueError('Host allowlist requires exact lowercase hostname, no URL/wildcard/port')
    urls = value['policy_urls']
    if not isinstance(urls, list) or not urls:
        raise ValueError('Policy URLs must not be empty')
    for raw in urls:
        if not isinstance(raw, str) or any(c.isspace() for c in raw): raise ValueError('Invalid policy URL')
        u = urllib.parse.urlsplit(raw)
        if u.scheme != 'https' or u.port not in (None,443) or u.username or u.password or u.fragment or u.query or u.hostname not in value['network_hosts']:
            raise ValueError('Policy URL must use allowlisted HTTPS 443 without credentials, query or fragment')
    executable = value['linux_executable']
    if not isinstance(executable, str) or not executable or '\\' in executable or '\0' in executable:
        raise ValueError('Invalid Linux executable path')
    p = pathlib.PurePosixPath(executable)
    if p.is_absolute() or any(part in ('..','.') for part in executable.split('/')):
        raise ValueError('Linux executable must be a safe relative path')
    return value

def parse_config(raw):
    if not isinstance(raw, str) or len(raw.encode()) > 16384:
        raise ValueError('Config exceeds runtime limit')
    return validate_config(json.loads(raw))
