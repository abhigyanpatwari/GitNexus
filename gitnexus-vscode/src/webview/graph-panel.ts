import * as vscode from 'vscode';
import {
  GitNexusService,
  type GraphFocusSymbolHint,
  type GraphNodeCandidate,
  type GraphNodeLocation,
} from '../services/gitnexus-service';

export class GraphPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static async show(
    context: vscode.ExtensionContext,
    service: GitNexusService,
    symbol?: string,
    focusHint?: GraphFocusSymbolHint,
  ): Promise<void> {
    if (!GraphPanel.panel) {
      GraphPanel.panel = vscode.window.createWebviewPanel(
        'gitnexusGraph',
        'GitNexus Insights',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
        },
      );

      GraphPanel.panel.webview.onDidReceiveMessage(async (message: unknown) => {
        await GraphPanel.handleWebviewMessage(service, message);
      });

      GraphPanel.panel.onDidDispose(() => {
        GraphPanel.panel = undefined;
      });

      context.subscriptions.push(GraphPanel.panel);
    }

    GraphPanel.panel.reveal(vscode.ViewColumn.Beside, true);
    GraphPanel.panel.webview.html = GraphPanel.loadingHtml();

    const payload = await service.getGraphPayload(symbol, focusHint);
    GraphPanel.panel.webview.html = GraphPanel.renderHtml(GraphPanel.panel.webview, context, payload);
  }

  private static async handleWebviewMessage(service: GitNexusService, message: unknown): Promise<void> {
    if (!isOpenNodeSourceMessage(message)) {
      return;
    }

    const { kind, label } = message.payload;
    const resolution = await service.resolveGraphNodeLocation(kind, label);

    if (resolution.status === 'resolved') {
      await GraphPanel.revealLocation(service, resolution.location);
      return;
    }

    if (resolution.status === 'ambiguous') {
      const picked = await GraphPanel.pickCandidate(resolution.candidates, label);
      if (!picked) {
        return;
      }

      const pickedResolution = await service.resolveGraphNodeCandidate(picked.uid);
      if (pickedResolution.status === 'resolved') {
        await GraphPanel.revealLocation(service, pickedResolution.location);
        return;
      }
    }

    void vscode.window.showInformationMessage(`GitNexus: ${resolution.message}`);
  }

  private static async pickCandidate(
    candidates: GraphNodeCandidate[],
    label: string,
  ): Promise<GraphNodeCandidate | undefined> {
    if (candidates.length === 0) {
      return undefined;
    }

    const items = candidates.map((candidate) => ({
      label: candidate.name,
      description: `${candidate.filePath}:${candidate.startLine + 1}`,
      candidate,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Choose Symbol Location',
      placeHolder: `Multiple symbols match '${label}'. Select the exact source location.`,
      ignoreFocusOut: true,
    });

    return picked?.candidate;
  }

  private static async revealLocation(service: GitNexusService, location: GraphNodeLocation): Promise<void> {
    const absolutePath = service.resolveAbsoluteRepoPath(location.filePath);
    const targetUri = vscode.Uri.file(absolutePath);

    const startLine = Math.max(0, location.startLine);
    const endLine = Math.max(startLine, location.endLine);
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, 0),
    );

    const document = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });

    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private static loadingHtml(): string {
    return `<!doctype html>
<html>
  <body style="font-family: var(--vscode-font-family); padding: 16px;">
    <h2>GitNexus Insights</h2>
    <p>Loading knowledge graph insights...</p>
  </body>
</html>`;
  }

  private static renderHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    payload: {
      title: string;
      subtitle?: string;
      nodes: unknown[];
      edges: unknown[];
    },
  ): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'graph.js'));
    const nonce = getNonce();
    const payloadJson = JSON.stringify(payload).replaceAll('<', '\\u003c');

    return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(payload.title)}</title>
  </head>
  <body style="margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background);">
    <div style="display: grid; grid-template-columns: minmax(300px, 1fr) 280px; height: 100vh; gap: 0;">
      <section style="position: relative; border-right: 1px solid var(--vscode-panel-border);">
        <div id="graph-canvas" style="width: 100%; height: 100%;"></div>
      </section>
      <aside style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
        <h2 style="margin: 0; font-size: 16px;">${escapeHtml(payload.title)}</h2>
        <p style="margin: 0; color: var(--vscode-descriptionForeground);">${escapeHtml(payload.subtitle ?? '')}</p>
        <p id="graph-stats" style="margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground);"></p>
        <pre id="graph-details" style="margin: 0; white-space: pre-wrap; word-wrap: break-word; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; flex: 1; overflow: auto; background: var(--vscode-editorWidget-background);"></pre>
      </aside>
    </div>
    <script nonce="${nonce}">window.__GITNEXUS_GRAPH__ = ${payloadJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

interface OpenNodeSourceMessage {
  command: 'gitnexus.openNodeSource';
  payload: {
    kind: 'repo' | 'module' | 'process' | 'symbol';
    label: string;
  };
}

function isOpenNodeSourceMessage(message: unknown): message is OpenNodeSourceMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const maybeMessage = message as { command?: unknown; payload?: unknown };
  if (maybeMessage.command !== 'gitnexus.openNodeSource') {
    return false;
  }

  const payload = maybeMessage.payload as { kind?: unknown; label?: unknown } | undefined;
  if (!payload) {
    return false;
  }

  if (typeof payload.kind !== 'string' || typeof payload.label !== 'string') {
    return false;
  }

  return payload.kind === 'repo' || payload.kind === 'module' || payload.kind === 'process' || payload.kind === 'symbol';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 20; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return nonce;
}
