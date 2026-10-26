"""Temporary paired time/RSS and retained-heap measurements on fixed runtimes."""
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
root, out = Path(args.runtime_parent), Path(args.output)
out.mkdir(parents=True, exist_ok=False)
harness = Path(args.harness).resolve()
heap_probe = Path(__file__).with_name('memory.mjs')
(out / 'environment.json').write_text(json.dumps({
    'corpus': args.corpus, 'harness_sha256': hashlib.sha256(harness.read_bytes()).hexdigest(),
    'heap_probe_sha256': hashlib.sha256(heap_probe.read_bytes()).hexdigest(),
    'cpus': sorted(os.sched_getaffinity(0)), 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'identity_cache': 'fresh private XDG_RUNTIME_DIR for every child',
    'baseline': 'e6744edcadbf93e789ab21a88e9e707cb3059ce7',
}, indent=2))


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


for comparison, candidate in [('aa', 'reference'), ('candidate', 'candidate')]:
    pairs = []
    for number in range(3):
        pair = {}
        for side in (['reference', 'candidate'] if number % 2 == 0 else ['candidate', 'reference']):
            print(f'{args.corpus} {comparison} pair {number + 1}/3: {side}', flush=True)
            pair[side] = run('reference' if side == 'reference' else candidate,
                             out / f'{comparison}-{number}-{side}.json')
        assert pair['reference']['manifest'] == pair['candidate']['manifest']
        assert [r['facts'] for r in pair['reference']['runs']] == [r['facts'] for r in pair['candidate']['runs']]
        pairs.append(pair)
        (out / f'{comparison}-pairs.json').write_text(json.dumps(pairs, indent=2))

heap_pairs = []
for language in ['java', 'typescript']:
    for number in range(5):
        pair = {'language': language, 'pair': number}
        for side in (['reference', 'candidate'] if number % 2 == 0 else ['candidate', 'reference']):
            command = ['node', '--expose-gc', str(heap_probe), '--root',
                       str(root / f'callable-{side}/gitnexus'), '--language', language]
            pair[side] = json.loads(subprocess.check_output(command, text=True, timeout=120))
        assert pair['reference']['digest'] == pair['candidate']['digest']
        assert pair['reference']['treeCollected'] and pair['candidate']['treeCollected']
        heap_pairs.append(pair)
        (out / 'heap-pairs.json').write_text(json.dumps(heap_pairs, indent=2))
print('All semantic, cache-replay, and tree-collection gates passed.', flush=True)

# Count allocations in a separate instrumented run; its time/RSS is discarded.
props = root / 'callable-candidate/gitnexus/dist/core/ingestion/utils/method-props.js'
original = props.read_text()
counts_path = out / 'collision-counts.jsonl'
prefix = "import { appendFileSync as __append } from 'node:fs';\n"
counted = original.replace('    return groups;',
    '    __append(' + json.dumps(str(counts_path)) +
    ', JSON.stringify({methods:methodMap.size,groups:groups.size})+"\\n");\n    return groups;')
assert counted != original
try:
    props.write_text(prefix + counted)
    traced = run('candidate', out / 'instrumented-discard-time-rss.json')
    assert [r['facts'] for r in traced['runs']] == [r['facts'] for r in pairs[-1]['candidate']['runs']]
    rows = [json.loads(line) for line in counts_path.read_text().splitlines()]
    (out / 'collision-summary.json').write_text(json.dumps({
        'builds': len(rows), 'methodVisits': sum(r['methods'] for r in rows),
        'groupArrays': sum(r['groups'] for r in rows),
        'timing_and_rss': 'instrumented; excluded from comparisons',
    }, indent=2))
finally:
    props.write_text(original)
