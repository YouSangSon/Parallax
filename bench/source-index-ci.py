"""Temporary, public-source CI diagnostic; removed before production landing."""
import base64
import gzip
import hashlib
import json
import pathlib
import subprocess
import sys
import urllib.parse


def emit(stage, value):
    print('PARALLAX_' + stage + ' ' + json.dumps(value), flush=True)


root = pathlib.Path(sys.argv[2]).resolve()
profile = root / 'source-index.cpuprofile'
if sys.argv[1] == '--profile':
    # Log chunks avoid a new artifact-storage charge and keep lines bounded.
    assert profile.is_file(), 'CPU profile missing; retain earlier stage/exit evidence'
    assert profile.stat().st_size <= 16 * 1024 * 1024, 'CPU profile size limit'
    raw = profile.read_bytes()
    data = json.loads(raw)
    checkout = pathlib.Path(sys.argv[3]).resolve()
    for entry in data['nodes']:
        url = entry['callFrame']['url']
        if not url or url.startswith('node:'):
            continue
        parsed = urllib.parse.urlparse(url)
        assert parsed.scheme in ('', 'file') and not parsed.netloc, 'unexpected profile URL scheme or host'
        source = pathlib.Path(urllib.parse.unquote(parsed.path)).resolve()
        assert source.is_relative_to(root) or source.is_relative_to(checkout), 'unexpected profile source'
    assert len(data['samples']) == len(data['timeDeltas'])
    compressed = gzip.compress(raw)
    assert len(compressed) <= 2 * 1024 * 1024, 'compressed profile size limit'
    encoded = base64.b64encode(compressed).decode()
    parts = [encoded[i:i + 16000] for i in range(0, len(encoded), 16000)]
    emit('CPU_PROFILE', {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                         'parts': len(parts), 'samples': len(data['samples'])})
    for i, part in enumerate(parts):
        emit('CPU_PROFILE_PART', {'index': i, 'data': part})
    emit('CPU_PROFILE_END', {'parts': len(parts)})
    raise SystemExit(0)

assert sys.argv[1] == '--run'
node = pathlib.Path(sys.argv[3]).resolve()
assert node.is_file() and node.is_absolute()
group = next(line.split(':', 2)[2].strip() for line in pathlib.Path('/proc/self/cgroup').read_text().splitlines()
             if line.startswith('0:'))
cgroup = pathlib.Path('/sys/fs/cgroup' + group)
limits = {name: (cgroup / name).read_text().strip() for name in ['cpu.max', 'memory.max', 'memory.swap.max']}
quota, period = map(int, limits['cpu.max'].split())
assert quota == period and limits['memory.max'] == '1073741824' and limits['memory.swap.max'] == '0', limits
module = root / 'baseline/dist/src/adapters/multi-language-regex.js'
module_sha = hashlib.sha256(module.read_bytes()).hexdigest()
assert module_sha == sys.argv[4], 'runtime module hash'
emit('RUNTIME', {'node': str(node), 'version': subprocess.check_output([str(node), '--version'], text=True).strip(),
                 'moduleSha256': module_sha, 'limits': limits,
                 'scope': 'One historical v39 baseline full index on public CI; not the earlier three-phase VM execution'})
try:
    result = subprocess.run([str(node), '--max-old-space-size=512', '--cpu-prof', '--cpu-prof-interval=50000',
                             '--cpu-prof-dir=' + str(root), '--cpu-prof-name=' + profile.name,
                             str(root / 'source-index.mjs'), str(root / 'baseline'), str(root / 'corpus'), str(root / 'input-manifest.json')],
                            cwd=root, timeout=90)
    emit('DIAGNOSTIC_EXIT', {'exit': result.returncode})
    raise SystemExit(result.returncode)
except subprocess.TimeoutExpired:
    emit('DIAGNOSTIC_EXIT', {'timeoutSeconds': 90, 'profileMayBeMissing': True})
    raise SystemExit(124)
finally:
    # Read while this unit exists; --collect may remove its cgroup afterwards.
    try:
        emit('CGROUP', {'memoryEvents': (cgroup / 'memory.events').read_text(),
                         'memoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
                         'cpuStat': (cgroup / 'cpu.stat').read_text()})
    except OSError as error:
        emit('CGROUP_UNAVAILABLE', {'error': type(error).__name__})
