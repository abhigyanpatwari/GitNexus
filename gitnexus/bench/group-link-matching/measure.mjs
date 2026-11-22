/**
 * Build-free scaling + identity bench for group.yaml link matching (#1188).
 *
 * A `links:` entry creates a consumer contract that may only match providers
 * in the repo the link names. This bench runs the matching stage of
 * `syncGroup` (provider index, exact pass, wildcard pass, and the strip of the
 * matching-only `meta.providerRepo`) over a synthetic group and gates two
 * things:
 *
 *   - `fingerprint`: every cross-link and every unmatched contract at the
 *     LARGE scale. It moves when a link consumer matches a repo its link does
 *     not name, when a consumer the passes could not place drops out of
 *     `unmatched`, or when `providerRepo` survives the strip.
 *   - `scaling_ratio`: (t_large / t_small) / (LARGE / SMALL). About 1.0 is
 *     linear in the number of links.
 *
 * Corpus, per link i (the #1188 shape, scaled):
 *   - an http link `svc-a -> svc-b POST::/import/i`, built by the real
 *     `ManifestExtractor`;
 *   - the same route served from source by four repos, the declared one first;
 *   - every 2nd link also has a source-extracted consumer in the consumer repo
 *     (it matches all four, which is the unrestricted case);
 *   - every 5th link names a repo that contributes nothing this run (its
 *     contracts are dropped, as `syncGroup` does for an unreadable repo), so
 *     the link consumer stays unmatched while its source twin, where present,
 *     matches.
 * Plus a FIXED number of service-wildcard links over a gRPC provider set that
 * grows with the corpus. The count is fixed on purpose: the wildcard pass
 * walks the whole provider index once per wildcard consumer, so its cost is
 * (wildcard links x provider keys) and only one of the two may scale here.
 *
 * Usage:
 *   node --import tsx bench/group-link-matching/measure.mjs
 *   node --import tsx bench/group-link-matching/measure.mjs --check
 *   node --import tsx bench/group-link-matching/measure.mjs --root <other checkout>/gitnexus
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minSample } from '../lib/identity-guard.mjs';
import { fingerprintIds, runBaselineCheck, runCountCheck } from '../lib/route-constant-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');
const SMALL = 2000;
const LARGE = 8000;
const REPS = 15;
const WARMUP = 5;
const PROVIDERS_PER_ROUTE = 4;
const WILDCARD_LINKS = 16;

// `--root` loads the matcher from another checkout, so the same corpus can be
// timed against a different revision.
const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1]) : path.resolve(__dirname, '../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const matching = await load('src/core/group/matching.ts');
const { ManifestExtractor } = await load('src/core/group/extractors/manifest-extractor.ts');
const { buildProviderIndex, runExactMatch, runWildcardMatch } = matching;
// Absent before #1188; the identity keeps `--root` usable on such a revision.
const strip = matching.withoutDeclaredProvider ?? ((contract) => contract);

const repoName = (n, repoCount) => `svc-${n % repoCount}`;

function sourceContract(contractId, role, repo, name) {
  return {
    contractId,
    type: contractId.slice(0, contractId.indexOf('::')),
    role,
    symbolUid: `${role}:${repo}:${name}`,
    symbolRef: { filePath: `src/${name}.ts`, name },
    symbolName: name,
    confidence: 0.9,
    meta: {},
    repo,
  };
}

async function buildCorpus(linkCount) {
  const repoCount = Math.max(16, linkCount / 8);
  const links = [];
  const source = [];
  // `<repo>|<contractId>` of provider contracts a link's unread repo would have
  // contributed, removed below.
  const unread = new Set();

  for (let i = 0; i < linkCount; i++) {
    const consumerRepo = repoName(i, repoCount);
    const declaredRepo = repoName(i + 1, repoCount);
    const contractId = `http::POST::/import/${i}`;
    const declaredIsUnread = i % 5 === 0;
    links.push({
      from: consumerRepo,
      to: declaredRepo,
      type: 'http',
      contract: `POST::/import/${i}`,
      role: 'consumer',
    });
    if (declaredIsUnread) unread.add(`${declaredRepo}|${contractId}`);
    for (let k = declaredIsUnread ? 1 : 0; k < PROVIDERS_PER_ROUTE; k++) {
      source.push(
        sourceContract(contractId, 'provider', repoName(i + 1 + k, repoCount), `import${i}`),
      );
    }
    if (i % 2 === 0) {
      source.push(sourceContract(contractId, 'consumer', consumerRepo, `callImport${i}`));
    }
  }

  for (let w = 0; w < WILDCARD_LINKS; w++) {
    links.push({
      from: repoName(w, repoCount),
      to: repoName(w + 1, repoCount),
      type: 'grpc',
      contract: `pkg${w}.Svc${w}/*`,
      role: 'consumer',
    });
  }
  for (let j = 0; j < linkCount / 4; j++) {
    const contractId = `grpc::pkg${j}.Svc${j}/Call`;
    source.push(sourceContract(contractId, 'provider', repoName(j + 1, repoCount), `call${j}`));
    source.push(sourceContract(contractId, 'provider', repoName(j + 2, repoCount), `call${j}`));
  }

  const manifest = await new ManifestExtractor().extractFromManifest(links);
  const fromLinks = manifest.contracts.filter(
    (c) => !(c.role === 'provider' && unread.has(`${c.repo}|${c.contractId}`)),
  );
  return [...source, ...fromLinks];
}

function match(contracts) {
  const index = buildProviderIndex(contracts);
  const exact = runExactMatch(contracts, index);
  const wildcard = runWildcardMatch(exact.unmatched, index);
  return {
    crossLinks: [...exact.matched, ...wildcard.matched],
    contracts: contracts.map(strip),
    unmatched: wildcard.remaining.map(strip),
  };
}

// Built outside the timed region: these strings grow with the corpus.
function identities(result) {
  return [
    ...result.crossLinks.map(
      (l) =>
        `${l.matchType}|${l.from.repo}|${l.from.symbolUid}|${l.to.repo}|${l.to.symbolUid}|${l.contractId}`,
    ),
    ...result.unmatched.map((c) => `unmatched|${c.role}|${c.repo}|${c.contractId}|${c.symbolUid}`),
  ];
}

async function measure(linkCount) {
  const contracts = await buildCorpus(linkCount);
  const { last, ms } = minSample(() => match(contracts), WARMUP, REPS);
  return {
    links: linkCount,
    contracts: contracts.length,
    ms: Number(ms.toFixed(3)),
    crossLinks: last.crossLinks.length,
    unmatched: last.unmatched.length,
    leakedProviderRepo: [...last.contracts, ...last.unmatched].filter(
      (c) => 'providerRepo' in c.meta,
    ).length,
    fingerprint: fingerprintIds(identities(last)),
  };
}

const report = { small: await measure(SMALL), large: await measure(LARGE) };
report.scaling_ratio = Number((report.large.ms / report.small.ms / (LARGE / SMALL)).toFixed(3));
report.absolute_ms = report.large.ms;
report.fingerprint = report.large.fingerprint;

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

runCountCheck(report, 'leakedProviderRepo', { small: 0, large: 0 });
runBaselineCheck(report, BASELINE_PATH);
