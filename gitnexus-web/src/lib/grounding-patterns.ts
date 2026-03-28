// Shared regex patterns for grounding references in chat/markdown.
// Pattern 1: File refs - [[path/file.ext]] or [[path/file.ext:line]] or [[path/file.ext:line-line]]
// Line numbers are optional.
export const FILE_REF_REGEX =
  /\[\[([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(?::(\d+)(?:[-–](\d+))?)?\]\]/g;

// Pattern 2: Node refs - [[Type:Name]] or [[graph:Type:Name]]
export const NODE_REF_REGEX =
  /\[\[(?:graph:)?(Class|Function|Method|Interface|File|Folder|Variable|Enum|Type|CodeElement):([^\]]+)\]\]/g;
