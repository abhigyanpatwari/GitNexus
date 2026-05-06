import { describe, expect, it } from 'vitest';
import { getAutoDeviceCandidates, getDeviceCandidates } from '../../src/core/embeddings/devices.js';

describe('embedding device selection', () => {
  it('prefers WebGPU and CoreML before CPU on macOS', () => {
    expect(getAutoDeviceCandidates('darwin')).toEqual(['webgpu', 'coreml', 'cpu']);
  });

  it('prefers DirectML before CPU on Windows', () => {
    expect(getAutoDeviceCandidates('win32')).toEqual(['dml', 'cpu']);
  });

  it('uses CUDA before CPU on Linux when CUDA is available', () => {
    expect(getAutoDeviceCandidates('linux', true)).toEqual(['cuda', 'cpu']);
  });

  it('uses CPU on Linux when CUDA is unavailable', () => {
    expect(getAutoDeviceCandidates('linux', false)).toEqual(['cpu']);
  });

  it('falls back from explicit accelerated devices to CPU', () => {
    expect(getDeviceCandidates('webgpu')).toEqual(['webgpu', 'cpu']);
    expect(getDeviceCandidates('coreml')).toEqual(['coreml', 'cpu']);
  });

  it('does not add fallback for explicit CPU or WASM', () => {
    expect(getDeviceCandidates('cpu')).toEqual(['cpu']);
    expect(getDeviceCandidates('wasm')).toEqual(['wasm']);
  });
});
