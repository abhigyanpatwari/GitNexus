import Module from 'module';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';

const OVERRIDE_ENV = 'GITNEXUS_ORT_BINDING_PATH';

/**
 * Redirect onnxruntime-node to a system-provided binding binary.
 *
 * onnxruntime-node always requires a native .node file from its own package.
 * We patch Node's module resolver so that specific request is redirected to
 * the path provided by GITNEXUS_ORT_BINDING_PATH.
 */
export const applyOnnxruntimeNodeBindingOverride = (): void => {
  const overridePath = process.env[OVERRIDE_ENV];
  if (!overridePath) return;

  if (!isAbsolute(overridePath)) {
    throw new Error(`${OVERRIDE_ENV} must be an absolute path, got "${overridePath}"`);
  }

  if (!existsSync(overridePath)) {
    throw new Error(`${OVERRIDE_ENV} points to a missing file: "${overridePath}"`);
  }

  const moduleAny = Module as typeof Module & {
    _gitnexusOrtBindingOverrideApplied?: boolean;
    _resolveFilename?: (
      request: string,
      parent: NodeModule | null,
      isMain: boolean,
      options?: unknown
    ) => string;
  };

  if (moduleAny._gitnexusOrtBindingOverrideApplied) return;
  moduleAny._gitnexusOrtBindingOverrideApplied = true;

  const originalResolve = moduleAny._resolveFilename?.bind(Module);
  if (!originalResolve) return;

  moduleAny._resolveFilename = function (
    request: string,
    parent: NodeModule | null,
    isMain: boolean,
    options?: unknown
  ): string {
    if (typeof request === 'string' && request.endsWith('onnxruntime_binding.node')) {
      return overridePath;
    }
    return originalResolve(request, parent, isMain, options);
  };
};
