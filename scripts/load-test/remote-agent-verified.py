"""Final controls: valid runtime signatures, warmed stable plans, batched UI."""
import json
import pathlib
import secrets
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
if root.parent != pathlib.Path('/var/tmp') or not root.name.startswith('forwardx-agent-bench-'):
    raise RuntimeError('Unsafe benchmark root')
prefix = 'fx-agent-bench-20261026-verified'
network, node, database = prefix + '-net', prefix + '-node', prefix + '-db'
password = secrets.token_hex(24)
for kind, name in [('container', node), ('container', database), ('network', network),
                   ('container', 'fx-agent-bench-20261026-calibration'), ('network', 'fx-agent-bench-20261026-net')]:
    if subprocess.run(['docker', kind, 'inspect', name], capture_output=True).returncode == 0:
        raise RuntimeError('Conflicting test target: ' + name)

def run(args, label, timeout=900):
    with (root / (label + '.log')).open('w') as log:
        subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=timeout)

base = ['docker', 'run', '--rm', '--name', node, '--cpus=1.25', '--memory=768m', '-v', str(root) + ':/work', '-w', '/work', '-e', 'TMPDIR=/work/tmp']
run(['docker', 'network', 'create', '--internal', network], 'verified-network')
try:
    for kind, scenarios in [('sqlite', ['few-dense', 'many-medium', 'many-scale']), ('mysql', ['many-scale']), ('postgresql', ['many-scale'])]:
        if kind != 'sqlite':
            dbname = 'forwardx_agent_bench_' + kind + '_verified'
            if kind == 'mysql':
                env = {'MYSQL_ROOT_PASSWORD': password, 'MYSQL_DATABASE': dbname, 'MYSQL_USER': 'benchmark', 'MYSQL_PASSWORD': password}
                image, memory, mount, port = 'mysql:8.0', '768m', '/var/lib/mysql', 3306
                extra = ['--innodb-buffer-pool-size=134217728', '--max-connections=64', '--skip-log-bin']
                ready = ['mysqladmin', '--protocol=tcp', '-h127.0.0.1', 'ping', '--silent']
                user = 'benchmark'
            else:
                env = {'POSTGRES_PASSWORD': password, 'POSTGRES_DB': dbname}
                image, memory, mount, port = 'postgres:16-bookworm', '512m', '/var/lib/postgresql/data', 5432
                extra = ['-c', 'shared_buffers=64MB', '-c', 'max_connections=64']
                ready, user = ['pg_isready', '-U', 'postgres'], 'postgres'
            (root / 'verified-db.env').write_text(''.join(str(k) + '=' + str(v) + '\n' for k, v in env.items()))
            (root / 'verified-db.env').chmod(0o600)
            (root / 'verified-database.json').write_text(json.dumps({'type': kind, kind: {'host': 'fxdb', 'port': port, 'database': dbname, 'user': user, 'password': password, 'ssl': False}}))
            (root / 'verified-database.json').chmod(0o600)
            data = root / (kind + '-verified-data')
            data.mkdir()
            run(['docker', 'run', '-d', '--name', database, '--network', network, '--network-alias', 'fxdb', '--cpus=0.5', '--memory=' + memory,
                 '--env-file', str(root / 'verified-db.env'), '-v', str(data) + ':' + mount, image, *extra], kind + '-verified-start')
            for attempt in range(90):
                if subprocess.run(['docker', 'exec', database, *ready], capture_output=True).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Database readiness timeout')
        try:
            for scenario in scenarios:
                label = 'verified-' + kind + '-' + scenario
                args = [*base, '--network', network, 'node:22-bookworm-slim', 'node', 'scripts/agent-load-test.mjs',
                        '--server-bundle=dist/load-test/agent-server.mjs', '--seconds=30', '--stages=steady,live', '--batch-pages', '--viewers=20',
                        '--scenarios=' + scenario, '--output=results/' + label + '.json']
                if kind != 'sqlite':
                    args.append('--db-config=verified-database.json')
                run(args, label)
                print(json.dumps({'finished': label}), flush=True)
            if kind != 'sqlite':
                oom = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.OOMKilled}}', database], text=True).strip()
                print(json.dumps({'database': kind, 'OOMKilled': oom}), flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', node], capture_output=True)
            if kind != 'sqlite':
                subprocess.run(['docker', 'rm', '-fv', database], check=True)
finally:
    subprocess.run(['docker', 'rm', '-f', node], capture_output=True)
    subprocess.run(['docker', 'rm', '-fv', database], capture_output=True)
    subprocess.run(['docker', 'network', 'rm', network], check=True)
