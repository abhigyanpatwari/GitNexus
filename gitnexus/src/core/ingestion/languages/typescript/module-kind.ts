import type { LanguageProvider } from '../../language-provider.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { assertCloneable } from '../../workers/clone-safety.js';
import { isCommonJsModule } from './cjs-export-assignment.js';

type CaptureEmitter = NonNullable<LanguageProvider['emitScopeCaptures']>;

// Collected immediately after extraction. Keep only the file's scalar fact;
// standalone capture calls cannot retain ASTs or maps.
let pending: { readonly filePath: string; readonly commonJs: boolean } | undefined;

export function withCommonJsModuleKind(emit: CaptureEmitter): CaptureEmitter {
  return (...args) => {
    pending = undefined;
    return emit(...args);
  };
}

export function recordCommonJsModuleKind(root: SyntaxNode, filePath: string): void {
  pending = { filePath, commonJs: isCommonJsModule(root, filePath) };
}

export function collectCommonJsModuleKind(filePath: string): boolean | undefined {
  const captured = pending;
  pending = undefined;
  return captured?.filePath === filePath ? assertCloneable(captured.commonJs) : undefined;
}
