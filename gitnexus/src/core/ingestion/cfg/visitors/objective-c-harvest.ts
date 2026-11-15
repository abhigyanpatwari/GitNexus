import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { StatementFacts } from '../types.js';
import { CCppHarvester } from './c-cpp-harvest.js';
import { CallSiteFactAccumulator as FactAccumulator } from './call-site-harvest.js';
import type { Scope } from './scope-tree-harvest.js';
import {
  catchParameter,
  fastEnumerationParts,
  OBJECTIVE_C_FUNCTION_TYPES,
} from './objective-c-ast.js';

/** Objective-C grammar additions on the C scalar def/use and lexical-scope walk. */
export class ObjectiveCHarvester extends CCppHarvester {
  constructor(fnNode: SyntaxNode) {
    super(fnNode);
    for (const [formalIndex, name] of this.parameterNames(fnNode).entries()) {
      const index = this.root.table.get(name.text);
      if (index !== undefined) this.bindings[index] = { ...this.bindings[index], formalIndex };
    }
  }

  protected override isNestedFunction(node: SyntaxNode): boolean {
    return OBJECTIVE_C_FUNCTION_TYPES.has(node.type) && node.id !== this.fnId;
  }

  protected override parameterNames(fnNode: SyntaxNode): SyntaxNode[] {
    if (fnNode.type === 'method_definition') {
      return fnNode.namedChildren
        .filter((child) => child.type === 'method_parameter')
        .flatMap((param) =>
          param.namedChildren.filter((child) => child.type === 'identifier').slice(-1),
        );
    }
    if (fnNode.type === 'block_literal') {
      const params = fnNode.namedChildren.find((child) => child.type === 'parameter_list');
      return (params?.namedChildren ?? []).flatMap((param) => {
        const name = this.declaratorName(param.childForFieldName('declarator'));
        return name ? [name] : [];
      });
    }
    return super.parameterNames(fnNode);
  }

  protected override declaratorName(node: SyntaxNode | null): SyntaxNode | undefined {
    if (node?.type === 'type_identifier') return node;
    if (node?.type === 'parenthesized_declarator') {
      const block = node.namedChildren.find((child) => child.type === 'block_pointer_declarator');
      if (block) return this.declaratorName(block.childForFieldName('declarator'));
    }
    if (node?.type === 'function_declarator' || node?.type === 'block_pointer_declarator') {
      return this.declaratorName(node.childForFieldName('declarator'));
    }
    return super.declaratorName(node);
  }

  protected override prescan(node: SyntaxNode, scope: Scope): void {
    const enumeration = fastEnumerationParts(node);
    if (enumeration || node.type === 'catch_clause') {
      this.nearestScopeCache.set(node.id, scope);
      const local = this.openScope(node);
      const name = this.declaratorName(enumeration?.declarator ?? catchParameter(node) ?? null);
      if (name) this.declare(name, enumeration ? 'var' : 'catch', local);
      for (const child of node.namedChildren) this.prescan(child, local);
      return;
    }
    super.prescan(node, scope);
  }

  override catchParamFacts(node: SyntaxNode): StatementFacts | undefined {
    const name = this.declaratorName(catchParameter(node) ?? null);
    if (!name) return undefined;
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.def(name, acc);
    return acc.finish();
  }

  override forRangeHeadFacts(node: SyntaxNode): StatementFacts {
    const parts = fastEnumerationParts(node);
    if (!parts) return super.forRangeHeadFacts(node);
    const acc = new FactAccumulator(node.startPosition.row + 1);
    const name = this.declaratorName(parts.declarator);
    if (name) this.def(name, acc);
    this.walkValue(parts.collection, acc);
    return acc.finish();
  }

  protected override registerResultDefs(value: SyntaxNode, defs: readonly number[]): void {
    let root = value;
    while (root.type === 'parenthesized_expression' && root.firstNamedChild)
      root = root.firstNamedChild;
    if (root.type === 'message_expression' && defs.length > 0)
      this.resultDefTargets.set(root.id, [...defs]);
    else super.registerResultDefs(value, defs);
  }

  protected override walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    if (this.isNestedFunction(node)) return;
    if (
      [
        'type_name',
        'method_type',
        'typedefed_specifier',
        'selector_expression',
        'protocol_expression',
        'encode_expression',
      ].includes(node.type)
    )
      return;
    if (node.type === 'declaration') {
      // Object pointers and block variables are scalar bindings. Indirect writes
      // through those bindings still use the inherited C lvalue rules.
      for (const child of node.namedChildren) {
        if (child.type !== 'init_declarator') continue;
        const declarator = child.childForFieldName('declarator');
        const value = child.childForFieldName('value');
        const name = this.declaratorName(declarator);
        if (name && value && declarator?.type !== 'array_declarator') {
          const before = acc.defSnapshot();
          this.def(name, acc);
          this.registerResultDefs(value, acc.defsSince(before));
        }
        if (value) this.walkValue(value, acc);
      }
      return;
    }
    if (node.type !== 'message_expression') {
      super.walkValue(node, acc);
      return;
    }

    const receiver = node.childForFieldName('receiver');
    const selectors = new Set(node.childrenForFieldName('method').map((child) => child.id));
    const children = node.children;
    const selector = children
      .filter((child) => selectors.has(child.id))
      .map((child) => `${child.text}${child.nextSibling?.type === ':' ? ':' : ''}`)
      .join('');
    const site = acc.openCallSite('call', [node.startPosition.row + 1, node.startPosition.column]);
    acc.pushFrame(site);
    if (receiver) {
      if (receiver.type === 'identifier') {
        const index = this.resolve(receiver);
        acc.addUse(index);
        acc.setSiteReceiver(site, index);
        acc.setSiteCallee(site, `${receiver.text}.${selector}`);
      } else {
        this.walkValue(receiver, acc);
      }
    }
    const result = this.resultDefTargets.get(node.id);
    if (result) acc.setSiteResultDefs(site, result);
    let position = 0;
    for (const child of node.namedChildren) {
      if (child.id === receiver?.id || selectors.has(child.id) || child.type === 'comment')
        continue;
      acc.setFrameArg(position++);
      this.walkValue(child, acc);
    }
    acc.popFrame();
  }
}
