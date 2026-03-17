import * as vscode from 'vscode';

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getSelectionOrWord(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) {
    return undefined;
  }

  const selected = editor.document.getText(editor.selection).trim();
  if (selected) {
    return selected;
  }

  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
  if (!wordRange) {
    return undefined;
  }

  const word = editor.document.getText(wordRange).trim();
  return word || undefined;
}

export function toShellArg(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/\"/g, '\\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}
