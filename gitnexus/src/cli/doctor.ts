import { getRuntimeCapabilities, getRuntimeFingerprint } from '../core/platform/capabilities.js';
import { resolveEmbeddingConfig } from '../core/embeddings/config.js';
import { isHttpMode } from '../core/embeddings/http-client.js';
import { getLocalEmbeddingRuntimeBlocker } from '../core/embeddings/runtime-support.js';
import { checkLbugNative } from '../core/lbug/native-check.js';
import { getExtensionInstallPolicy } from '../core/lbug/extension-loader.js';
import { t } from './i18n/index.js';

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint === 0) continue;
    if (isCombiningMark(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function padDisplayEnd(value: string, columns: number): string {
  return value + ' '.repeat(Math.max(0, columns - displayWidth(value)));
}

const label = (key: Parameters<typeof t>[0], width: number): string => padDisplayEnd(t(key), width);

/**
 * Embedding-runtime support status for the `doctor` Embeddings section.
 * Pure and DI-friendly so it can be unit-tested without running the whole
 * command. Delegates the platform decision to
 * {@link getLocalEmbeddingRuntimeBlocker} so the wording stays in one place.
 *
 * - HTTP mode: always supported (never touches the native runtime).
 * - Local mode on an unsupported platform (macOS Intel, #1515): reports the
 *   blocker as `detail` so the caller can surface the full guidance.
 */
export function localEmbeddingDoctorStatus(opts: {
  httpMode: boolean;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): { status: string; detail: string | null } {
  if (opts.httpMode) {
    return { status: '✓ http endpoint configured', detail: null };
  }
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const blocker = getLocalEmbeddingRuntimeBlocker({ platform, arch });
  if (blocker) {
    return { status: `✗ local embeddings unavailable on ${platform}/${arch}`, detail: blocker };
  }
  return { status: '✓ local embeddings supported', detail: null };
}

export const doctorCommand = async () => {
  const fingerprint = getRuntimeFingerprint();
  const capabilities = getRuntimeCapabilities();
  const embeddingConfig = resolveEmbeddingConfig();

  console.log(t('doctor.title') + '\n');
  console.log(t('doctor.runtime'));
  console.log(`  ${label('doctor.labels.os', 10)}${fingerprint.platform}/${fingerprint.arch}`);
  console.log(`  ${label('doctor.labels.node', 10)}${fingerprint.node}`);
  console.log(`  ${label('doctor.labels.gitnexus', 10)}${fingerprint.gitnexus}`);
  console.log(`  ${label('doctor.labels.ladybugdb', 10)}${fingerprint.ladybugdb ?? 'unknown'}`);
  const nativeCheck = checkLbugNative();
  if (nativeCheck.ok) {
    console.log(`  ${padDisplayEnd('native', 10)}✓ lbugjs.node loaded`);
  } else {
    console.log(`  ${padDisplayEnd('native', 10)}✗ lbugjs.node missing`);
    process.stderr.write(`\n${nativeCheck.message?.replace(/^/gm, '  ')}\n\n`);
  }
  console.log(`  ${label('doctor.labels.onnx', 10)}${fingerprint.onnxruntime ?? 'unknown'}`);
  console.log('');
  console.log(t('doctor.capabilities'));
  console.log(`  ${label('doctor.labels.graphStore', 18)}${capabilities.graph}`);
  console.log(`  ${label('doctor.labels.fullTextSearch', 18)}${capabilities.fts}`);
  console.log(`  ${label('doctor.labels.vectorIndex', 18)}${capabilities.vector}`);
  console.log(`  ${label('doctor.labels.semanticMode', 18)}${capabilities.semanticMode}`);
  // Surface the optional-extension install policy so offline users can see
  // whether analyze/query will reach the network (extension.ladybugdb.com).
  // Literal label (like the 'native' line) to avoid adding i18n keys.
  const installPolicy = getExtensionInstallPolicy();
  const policyHint =
    installPolicy === 'load-only'
      ? ' (offline; load only, no network install)'
      : installPolicy === 'never'
        ? ' (optional extensions disabled)'
        : ' (installs missing extensions over network)';
  console.log(`  ${padDisplayEnd('Ext install:', 18)}${installPolicy}${policyHint}`);
  console.log(
    `  ${label('doctor.labels.exactScanLimit', 18)}${t('doctor.chunks', { count: capabilities.exactScanLimit })}`,
  );
  if (capabilities.reason)
    console.log(`  ${label('doctor.labels.note', 18)}${capabilities.reason}`);
  console.log('');
  console.log(t('doctor.embeddings'));
  console.log(`  ${label('doctor.labels.backend', 12)}${isHttpMode() ? 'http' : 'local'}`);
  console.log(`  ${label('doctor.labels.device', 12)}${embeddingConfig.device}`);
  console.log(`  ${label('doctor.labels.threads', 12)}${embeddingConfig.threads}`);
  console.log(
    `  ${label('doctor.labels.batch', 12)}${t('doctor.nodes', { count: embeddingConfig.batchSize })}`,
  );
  console.log(
    `  ${label('doctor.labels.subBatch', 12)}${t('doctor.chunks', { count: embeddingConfig.subBatchSize })}`,
  );
  // Surface local-runtime support so macOS Intel users see up front that local
  // embeddings can't load here (the bundled ONNX Runtime ships no darwin/x64
  // native binding, #1515) — rather than discovering it only when
  // `analyze --embeddings` fails. Literal label like the 'native' line above.
  const support = localEmbeddingDoctorStatus({ httpMode: isHttpMode() });
  console.log(`  ${padDisplayEnd('Support:', 12)}${support.status}`);
  if (support.detail) {
    process.stderr.write(`\n${support.detail.replace(/^/gm, '  ')}\n\n`);
  }
};
