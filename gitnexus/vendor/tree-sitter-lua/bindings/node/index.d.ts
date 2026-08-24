// Type stub mirroring gitnexus/vendor/tree-sitter-c/bindings/node/index.d.ts.
// The runtime binding is a native .node loaded by node-gyp-build; this stub
// gives TypeScript a Language-shaped module to import.
type BaseNode = {
  type: string;
  named: boolean;
};

type ChildNode = {
  multiple: boolean;
  required: boolean;
  types: BaseNode[];
};

type NodeInfo =
  | (BaseNode & {
      subtypes: BaseNode[];
    })
  | (BaseNode & {
      fields: { [name: string]: ChildNode };
      children: ChildNode[];
    });

type Language = {
  name: string;
  language: unknown;
  nodeTypeInfo: NodeInfo[];
};

declare const language: Language;
export = language;
