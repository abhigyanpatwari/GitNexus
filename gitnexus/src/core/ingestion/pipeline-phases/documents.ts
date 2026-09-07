import path from 'node:path';
import { generateId } from '../../../lib/utils.js';
import { logger } from '../../logger.js';
import { DOCUMENT_PARSERS } from '../documents/registry.js';
import { readFileContents } from '../filesystem-walker.js';
import { getPhaseOutput, type PipelinePhase } from './types.js';
import type { StructureOutput } from './structure.js';

export const documentsPhase: PipelinePhase<{ sections: number; failures: number }> = {
  name: 'documents',
  deps: ['structure'],
  async execute(ctx, deps) {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const files = scannedFiles.filter((file) =>
      DOCUMENT_PARSERS.has(path.extname(file.path).toLowerCase()),
    );
    let sections = 0;
    let failures = 0;
    for (const file of files) {
      const fileId = generateId('File', file.path);
      if (!ctx.graph.getNode(fileId)) continue;
      const content = (await readFileContents(ctx.repoPath, [file.path])).get(file.path);
      if (content === undefined) continue;
      const parser = DOCUMENT_PARSERS.get(path.extname(file.path).toLowerCase())!;
      let declarations;
      try {
        declarations = parser(content);
      } catch {
        failures++;
        logger.warn(
          { filePath: file.path },
          'Document declarations omitted: invalid or unsupported document',
        );
        continue;
      }
      for (const declaration of declarations) {
        const { startIndex, ...properties } = declaration;
        const id = generateId('Section', `${file.path}:${startIndex}:${declaration.description}`);
        ctx.graph.addNode({
          id,
          label: 'Section',
          properties: { ...properties, filePath: file.path },
        });
        ctx.graph.addRelationship({
          id: generateId('CONTAINS', `${fileId}->${id}`),
          type: 'CONTAINS',
          sourceId: fileId,
          targetId: id,
          confidence: 1,
          reason: 'document-declaration',
        });
        sections++;
      }
    }
    return { sections, failures };
  },
};
