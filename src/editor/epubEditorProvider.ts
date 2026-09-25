import * as vscode from "vscode";
import { EpubDocument } from "./epubDocument";
import { ReaderSession } from "./readerSession";
import { ReaderStore } from "./storage";

/**
 * Custom editor for `.epub` files. The document is a read-only view of the
 * archive, so save/revert are no-ops and the editor never becomes dirty.
 */
export class EpubEditorProvider implements vscode.CustomEditorProvider<EpubDocument> {
  static readonly viewType = "epubReader.reader";

  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<EpubDocument>
  >();

  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReaderStore,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    store: ReaderStore,
  ): vscode.Disposable {
    const provider = new EpubEditorProvider(context, store);
    return vscode.window.registerCustomEditorProvider(EpubEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<EpubDocument> {
    const data = await vscode.workspace.fs.readFile(uri);
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    return EpubDocument.open(this.context, uri, Buffer.from(data));
  }

  async resolveCustomEditor(
    document: EpubDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    panel.title = document.book?.metadata.title ?? fileName(document.uri);
    const session = new ReaderSession(document, panel, this.context, this.store);
    await session.activate(token);
  }

  async saveCustomDocument(): Promise<void> {
    // Read-only viewer: there is nothing to persist back into the file.
  }

  async saveCustomDocumentAs(document: EpubDocument, destination: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.copy(document.uri, destination, { overwrite: true });
  }

  async revertCustomDocument(): Promise<void> {
    // Nothing to revert.
  }

  async backupCustomDocument(
    document: EpubDocument,
    _context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    return {
      id: document.uri.toString(),
      delete: async () => {
        /* no backup data was written */
      },
    };
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function fileName(uri: vscode.Uri): string {
  const base = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  return base.length > 0 ? base : uri.fsPath;
}
