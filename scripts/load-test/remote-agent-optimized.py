"""Isolated Linux comparison runner; never connects to the host database."""
import json
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
if root != pathlib.Path('/var/tmp/forwardx-agent-opt-20261026') or root.is_symlink():
    raise RuntimeError('Unsafe benchmark directory')
prefix = 'fx-agent-opt-20261026'
tag = next((arg[6:] for arg in sys.argv[2:] if arg.startswith('--tag=')), 'final')
if not re.fullmatch('[a-z0-9-]{1,24}', tag):
    raise RuntimeError('Unsafe run tag')
selected = [arg for arg in sys.argv[2:] if not arg.startswith('--tag=')]
if any(kind not in ['sqlite', 'mysql', 'postgresql'] for kind in selected):
    raise RuntimeError('Unknown database selection')
network, node, database = prefix + '-net', prefix + '-node', prefix + '-db'
password = secrets.token_hex(24)
for kind, name in [('container', node), ('container', database), ('network', network)]:
    if subprocess.run(['docker', kind, 'inspect', name], capture_output=True).returncode == 0:
        raise RuntimeError('Conflicting test target: ' + name)

def run(args, label, timeout=900):
    with (root / (label + '.log')).open('w') as log:
        subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=timeout)

for image in ['node:22-bookworm-slim', 'mysql:8.0', 'postgres:16-bookworm']:
    run(['docker', 'pull', image], 'pull-' + image.split(':')[0])
shutil.copyfile(root / 'scripts/load-test/agent-package.json', root / 'package.json')
for directory in ['tmp', 'results']:
    (root / directory).mkdir(exist_ok=True)
run(['docker', 'run', '--rm', '--name', node, '--cpus=1', '--memory=768m', '-v', str(root) + ':/work', '-w', '/work',
     'node:22-bookworm-slim', 'npm', 'install', '--omit=dev', '--no-audit', '--no-fund'], 'install')
base = ['docker', 'run', '--rm', '--name', node, '--cpus=1.25', '--memory=768m', '-v', str(root) + ':/work', '-w', '/work', '-e', 'TMPDIR=/work/tmp']
run(['docker', 'network', 'create', '--internal', network], 'network')
try:
    for kind, scenarios in [('sqlite', ['few-dense', 'many-medium', 'many-scale']), ('mysql', ['many-scale']), ('postgresql', ['many-scale'])]:
        if selected and kind not in selected:
            continue
        if kind != 'sqlite':
            dbname = 'forwardx_agent_bench_' + kind + ('_' + tag.replace('-', '_') if selected else '_optimized')
            if kind == 'mysql':
                env = {'MYSQL_ROOT_PASSWORD': password, 'MYSQL_DATABASE': dbname, 'MYSQL_USER': 'benchmark', 'MYSQL_PASSWORD': password}
                image, memory, mount, port, user = 'mysql:8.0', '768m', '/var/lib/mysql', 3306, 'benchmark'
                extra = ['--innodb-buffer-pool-size=134217728', '--max-connections=64', '--skip-log-bin']
                ready = ['mysqladmin', '--protocol=tcp', '-h127.0.0.1', 'ping', '--silent']
            else:
                env = {'POSTGRES_PASSWORD': password, 'POSTGRES_DB': dbname}
                image, memory, mount, port, user = 'postgres:16-bookworm', '512m', '/var/lib/postgresql/data', 5432, 'postgres'
                extra = ['-c', 'shared_buffers=64MB', '-c', 'max_connections=64']
                ready = ['pg_isready', '-U', 'postgres']
            for filename, value in [('db.env', ''.join(k + '=' + v + '\n' for k, v in env.items())),
                                    ('database.json', json.dumps({'type': kind, kind: {'host': 'fxdb', 'port': port, 'database': dbname, 'user': user, 'password': password, 'ssl': False}}))]:
                (root / filename).write_text(value)
                (root / filename).chmod(0o600)
            data = root / (kind + ('-' + tag + '-data' if selected else '-data'))
            data.mkdir()
            run(['docker', 'run', '-d', '--name', database, '--network', network, '--network-alias', 'fxdb', '--cpus=0.5', '--memory=' + memory,
                 '--env-file', str(root / 'db.env'), '-v', str(data) + ':' + mount, image, *extra], kind + '-start')
            for attempt in range(90):
                if subprocess.run(['docker', 'exec', database, *ready], capture_output=True).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Database readiness timeout')
        try:
            for scenario in scenarios:
                label = ('optimized-' + tag + '-' if selected else 'optimized-') + kind + '-' + scenario
                args = [*base, '--network', network, 'node:22-bookworm-slim', 'node', 'scripts/agent-load-test.mjs',
                        '--server-bundle=dist/load-test/agent-server.mjs', '--seconds=30', '--stages=steady,live,operations', '--batch-pages',
                        '--viewers=20', '--operators=50', '--scenarios=' + scenario, '--output=results/' + label + '.json']
                if kind != 'sqlite':
                    args.append('--db-config=database.json')
                run(args, label)
                print(json.dumps({'finished': label}), flush=True)
            if kind != 'sqlite':
                print(json.dumps({'database': kind, 'OOMKilled': subprocess.check_output(['docker', 'inspect', '--format', '{{.State.OOMKilled}}', database], text=True).strip()}), flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', node], capture_output=True)
            if kind != 'sqlite':
                subprocess.run(['docker', 'rm', '-fv', database], check=True)
finally:
    subprocess.run(['docker', 'rm', '-f', node], capture_output=True)
    subprocess.run(['docker', 'rm', '-fv', database], capture_output=True)
    subprocess.run(['docker', 'network', 'rm', network], check=True)
