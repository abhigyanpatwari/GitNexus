import { parse } from '@babel/parser';
import { generate } from '@babel/generator';
import * as t from '@babel/types';
import type { Plugin } from 'vite';
import { FIXTURE_CAPTURE_KEY } from './fixture-capture.js';

/** Instrument only the prepared coverage run; production sources remain unchanged. */
export function fixtureCapturePlugin(pipelineFile: string): Plugin {
  return {
    name: 'scenario-map-fixture-inputs',
    enforce: 'pre',
    transform(code, id) {
      if (id.replace(/\\/g, '/').split('?')[0] !== pipelineFile.replace(/\\/g, '/')) return null;
      const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
      let found = false;
      for (const statement of ast.program.body) {
        const declaration = t.isExportNamedDeclaration(statement)
          ? statement.declaration
          : statement;
        if (!t.isVariableDeclaration(declaration)) continue;
        for (const variable of declaration.declarations) {
          if (
            !t.isIdentifier(variable.id, { name: 'runPipelineFromRepo' }) ||
            !t.isArrowFunctionExpression(variable.init) ||
            !t.isBlockStatement(variable.init.body)
          )
            continue;
          const parameter = variable.init.params[0];
          if (!t.isIdentifier(parameter))
            throw new Error('fixture capture: unsupported pipeline root parameter');
          const hook = t.optionalCallExpression(
            t.memberExpression(
              t.identifier('globalThis'),
              t.stringLiteral(FIXTURE_CAPTURE_KEY),
              true,
            ),
            [t.identifier(parameter.name)],
            true,
          );
          variable.init.body.body.unshift(t.expressionStatement(hook));
          found = true;
        }
      }
      if (!found) throw new Error('fixture capture: pipeline entry point was not instrumented');
      const result = generate(
        ast,
        { sourceMaps: true, sourceFileName: id, retainLines: true },
        code,
      );
      return { code: result.code, map: result.map === null ? null : JSON.stringify(result.map) };
    },
  };
}
