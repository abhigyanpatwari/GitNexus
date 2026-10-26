"""Temporary experiment driver: fixed runtimes, frozen workload, paired fresh processes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--runtime-parent', required=True)
parser.add_argument('--corpus', choices=['repository', 'declarations'], required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--harness', required=True)
args = parser.parse_args()
root = Path(args.runtime_parent)
out = Path(args.output)
out.mkdir(parents=True, exist_ok=False)
harness = Path(args.harness).resolve()
manifest = {'corpus': args.corpus, 'harness_sha256': hashlib.sha256(harness.read_bytes()).hexdigest(),
            'cpus': sorted(os.sched_getaffinity(0)), 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
            'identity_cache': 'fresh private XDG_RUNTIME_DIR for every child on both sides'}
(out / 'environment.json').write_text(json.dumps(manifest, indent=2))


def run(variant, destination):
    with tempfile.TemporaryDirectory(prefix='callable-identity-', dir=root) as cache:
        proc = subprocess.run(['node', '--expose-gc', str(harness), '--child', 'analysis', '--root',
                               str(root / f'callable-{variant}/gitnexus'), '--corpus', args.corpus],
                              env={**os.environ, 'XDG_RUNTIME_DIR': cache},
                              text=True, capture_output=True, timeout=600)
    destination.with_suffix('.stdout').write_text(proc.stdout)
    destination.with_suffix('.stderr').write_text(proc.stderr)
    proc.check_returncode()
    result = json.loads(next(line.removeprefix('BENCH_RESULT=') for line in proc.stdout.splitlines()
                             if line.startswith('BENCH_RESULT=')))
    destination.write_text(json.dumps(result, indent=2))
    assert json.loads(destination.read_text()) == result
    runs = result['runs']
    assert [r['scenario'] for r in runs] == ['cold', 'warm', 'changed']
    assert all(r['facts']['nodes'] > 0 and r['facts']['edges'] > 0 for r in runs)
    assert runs[1]['reparsed'] == 0 and runs[2]['reparsed'] == 1
    assert runs[0]['facts'] == runs[1]['facts'] and runs[0]['facts']['hash'] != runs[2]['facts']['hash']
    return result


for comparison, reference, candidate in [('aa', 'control', 'control'),
                                         ('control', 'control', 'candidate'),
                                         ('initial', 'initial', 'candidate')]:
    pairs = []
    for number in range(3):
        pair = {}
        for side in (['reference', 'candidate'] if number % 2 == 0 else ['candidate', 'reference']):
            print(f'{comparison} pair {number + 1}/3: {side}', flush=True)
            variant = reference if side == 'reference' else candidate
            pair[side] = run(variant, out / f'{comparison}-{number}-{side}.json')
        assert pair['reference']['manifest'] == pair['candidate']['manifest']
        assert [r['facts'] for r in pair['reference']['runs']] == [r['facts'] for r in pair['candidate']['runs']]
        pairs.append(pair)
        (out / f'{comparison}-pairs.json').write_text(json.dumps(pairs, indent=2))
    snapshots = {}
    for side in ['reference', 'candidate']:
        metrics = {}
        for index, scenario in enumerate(['cold', 'warm', 'changed']):
            values = [pair[side]['runs'][index]['wallMs'] for pair in pairs]
            metrics[scenario + '_ms'] = {'aggregate': statistics.median(values), 'samples': values}
        totals = [sum(r['wallMs'] for r in pair[side]['runs']) for pair in pairs]
        metrics['total_ms'] = {'aggregate': statistics.median(totals), 'samples': totals}
        snapshots[side] = {'metrics': metrics, 'gates': {'graph_parity': 1}}
    (out / f'{comparison}-summary.json').write_text(json.dumps(snapshots, indent=2))
