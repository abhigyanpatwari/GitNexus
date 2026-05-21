import { getRuntimeCapabilities, getRuntimeFingerprint } from '../core/platform/capabilities.js';
import { resolveEmbeddingConfig } from '../core/embeddings/config.js';
import { isHttpMode } from '../core/embeddings/http-client.js';
import { t } from './i18n/index.js';

export const doctorCommand = async () => {
  const fingerprint = getRuntimeFingerprint();
  const capabilities = getRuntimeCapabilities();
  const embeddingConfig = resolveEmbeddingConfig();

  console.log(t('doctor.title') + '\n');
  console.log(t('doctor.runtime'));
  console.log(`  ${t('doctor.labels.os').padEnd(10)}${fingerprint.platform}/${fingerprint.arch}`);
  console.log(`  ${t('doctor.labels.node').padEnd(10)}${fingerprint.node}`);
  console.log(`  ${t('doctor.labels.gitnexus').padEnd(10)}${fingerprint.gitnexus}`);
  console.log(`  ${t('doctor.labels.ladybugdb').padEnd(10)}${fingerprint.ladybugdb ?? 'unknown'}`);
  console.log(`  ${t('doctor.labels.onnx').padEnd(10)}${fingerprint.onnxruntime ?? 'unknown'}`);
  console.log('');
  console.log(t('doctor.capabilities'));
  console.log(`  ${t('doctor.labels.graphStore').padEnd(18)}${capabilities.graph}`);
  console.log(`  ${t('doctor.labels.fullTextSearch').padEnd(18)}${capabilities.fts}`);
  console.log(`  ${t('doctor.labels.vectorIndex').padEnd(18)}${capabilities.vector}`);
  console.log(`  ${t('doctor.labels.semanticMode').padEnd(18)}${capabilities.semanticMode}`);
  console.log(
    `  ${t('doctor.labels.exactScanLimit').padEnd(18)}${t('doctor.chunks', { count: capabilities.exactScanLimit })}`,
  );
  if (capabilities.reason)
    console.log(`  ${t('doctor.labels.note').padEnd(18)}${capabilities.reason}`);
  console.log('');
  console.log(t('doctor.embeddings'));
  console.log(`  ${t('doctor.labels.backend').padEnd(12)}${isHttpMode() ? 'http' : 'local'}`);
  console.log(`  ${t('doctor.labels.device').padEnd(12)}${embeddingConfig.device}`);
  console.log(`  ${t('doctor.labels.threads').padEnd(12)}${embeddingConfig.threads}`);
  console.log(
    `  ${t('doctor.labels.batch').padEnd(12)}${t('doctor.nodes', { count: embeddingConfig.batchSize })}`,
  );
  console.log(
    `  ${t('doctor.labels.subBatch').padEnd(12)}${t('doctor.chunks', { count: embeddingConfig.subBatchSize })}`,
  );
};
