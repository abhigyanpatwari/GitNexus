import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import type { EmbeddingDevice } from './types.js';

export type ConcreteEmbeddingDevice = Exclude<EmbeddingDevice, 'auto'>;

/**
 * Check whether the onnxruntime-node package that @huggingface/transformers
 * will actually load at runtime ships the CUDA execution provider.
 */
function hasOrtCudaProvider(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const transformersDir = dirname(require.resolve('@huggingface/transformers/package.json'));
    const ortRequire = createRequire(join(transformersDir, 'package.json'));
    const ortPath = dirname(ortRequire.resolve('onnxruntime-node/package.json'));
    const arch = process.arch;
    return existsSync(
      join(ortPath, 'bin', 'napi-v6', 'linux', arch, 'libonnxruntime_providers_cuda.so'),
    );
  } catch {
    return false;
  }
}

/**
 * Check whether CUDA libraries are actually available on this system.
 */
export function isCudaAvailable(): boolean {
  if (!hasOrtCudaProvider()) return false;

  try {
    const out = execFileSync('ldconfig', ['-p'], { timeout: 3000, encoding: 'utf-8' });
    if (out.includes('libcublasLt.so.12')) return true;
  } catch {
    // ldconfig is not available on every platform/container.
  }

  for (const envVar of ['CUDA_PATH', 'LD_LIBRARY_PATH']) {
    const val = process.env[envVar];
    if (!val) continue;
    for (const dir of val.split(':').filter(Boolean)) {
      if (
        existsSync(join(dir, 'lib64', 'libcublasLt.so.12')) ||
        existsSync(join(dir, 'lib', 'libcublasLt.so.12')) ||
        existsSync(join(dir, 'libcublasLt.so.12'))
      ) {
        return true;
      }
    }
  }

  return false;
}

export function getAutoDeviceCandidates(
  platform: NodeJS.Platform = process.platform,
  cudaAvailable?: boolean,
): ConcreteEmbeddingDevice[] {
  if (platform === 'darwin') return ['webgpu', 'coreml', 'cpu'];
  if (platform === 'win32') return ['dml', 'cpu'];
  if (platform === 'linux' && (cudaAvailable ?? isCudaAvailable())) return ['cuda', 'cpu'];
  return ['cpu'];
}

export function isAcceleratedDevice(device: ConcreteEmbeddingDevice): boolean {
  return device !== 'cpu' && device !== 'wasm';
}

export function getDeviceCandidates(device: EmbeddingDevice): ConcreteEmbeddingDevice[] {
  if (device === 'auto') return getAutoDeviceCandidates();

  return isAcceleratedDevice(device) ? [device, 'cpu'] : [device];
}

export function formatDeviceLabel(device: ConcreteEmbeddingDevice): string {
  switch (device) {
    case 'webgpu':
      return 'GPU (WebGPU/Metal)';
    case 'coreml':
      return 'GPU/ANE (CoreML)';
    case 'dml':
      return 'GPU (DirectML/DirectX12)';
    case 'cuda':
      return 'GPU (CUDA)';
    case 'wasm':
      return 'WASM';
    case 'cpu':
      return 'CPU';
  }
}
