import type { LanguageProvider } from '../../language-provider.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { assertCloneable } from '../../workers/clone-safety.js';
import { isCommonJsModule } from './cjs-export-assignment.js';

type CaptureEmitter = NonNullable<LanguageProvider['emitScopeCaptures']>;

// The worker collects immediately after extracting each file. Keep only that
// file's scalar fact, so standalone capture calls cannot retain ASTs or maps.
let pending: { readonly filePath: string; readonly commonJs: boolean } | undefined;

export function withCommonJsModuleKind(emit: CaptureEmitter): CaptureEmitter {
  return (...args) => {
    pending = undefined;
    const captures = emit(...args);
    const root = (args[2] as { readonly rootNode?: SyntaxNode } | undefined)?.rootNode;
    if (root !== undefined) {
      pending = { filePath: args[1], commonJs: isCommonJsModule(root, args[1]) };
    }
    return captures;
  };
}

export function collectCommonJsModuleKind(filePath: string): boolean | undefined {
  const captured = pending;
  pending = undefined;
  return captured?.filePath === filePath ? assertCloneable(captured.commonJs) : undefined;
}
