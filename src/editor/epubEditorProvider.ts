import * as vscode from "vscode";
import { EpubDocument } from "./epubDocument";
import { READER_VIEW_TYPE } from "./protocol";
import { ReaderSession } from "./readerSession";
import { ReaderStore } from "./storage";

/** Name of the hot-exit backup file, also used to recognise our backups. */
const BACKUP_FILE_NAME = "epub-view-edits.json";

/**
 * Custom editor for `.epub` files. Reading is the main job, but the document
 * is editable: text edits land in the document's overlay, the tab goes dirty,
 * and saving rewrites the archive with only the edited entries recompressed.
 */
export class EpubEditorProvider implements vscode.CustomEditorProvider<EpubDocument> {
  static readonly viewType = READER_VIEW_TYPE;

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
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<EpubDocument> {
    const data = await vscode.workspace.fs.readFile(uri);
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const restored = await readBackupEdits(openContext.backupId);
    return EpubDocument.open(this.context, uri, Buffer.from(data), restored);
  }

  async resolveCustomEditor(
    document: EpubDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    panel.title = document.book?.metadata.title ?? fileName(document.uri);
    const session = new ReaderSession(document, panel, this.context, this.store, (edit) => {
      // The webview's edit becomes a step on VS Code's undo stack. VS Code
      // resolves the document through its own registry here, and that lookup
      // is what fails ("No custom document found") for a tab restored after a
      // window reload — so a rejection must never escape into the edit path.
      if (document.linkBroken) {
        return false;
      }
      try {
        this.changeEmitter.fire({
          document,
          label: edit.label,
          undo: edit.undo,
          redo: edit.redo,
        });
        return true;
      } catch (error) {
        document.markLinkBroken(error instanceof Error ? error.message : String(error));
        return false;
      }
    });
    await session.activate(token);
  }

  async saveCustomDocument(
    document: EpubDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      return;
    }
    await document.writeToDisk();
  }

  async saveCustomDocumentAs(
    document: EpubDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const bytes = document.assembleEditedBytes();
    if (bytes) {
      await vscode.workspace.fs.writeFile(destination, bytes);
      return;
    }
    await vscode.workspace.fs.copy(document.uri, destination, { overwrite: true });
  }

  async revertCustomDocument(
    document: EpubDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    document.revertAll();
  }

  async backupCustomDocument(
    document: EpubDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const edits = document.editsSnapshot();
    if (Object.keys(edits).length === 0) {
      return { id: `${BACKUP_FILE_NAME}:clean`, delete: async () => undefined };
    }
    const file = vscode.Uri.joinPath(context.destination, BACKUP_FILE_NAME);
    const payload = Buffer.from(JSON.stringify({ version: 1, edits }), "utf8");
    await vscode.workspace.fs.writeFile(file, payload);
    return {
      id: file.toString(),
      delete: async () => {
        await discard(file);
      },
    };
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Read pending edits from a hot-exit backup, then drop the backup file. */
async function readBackupEdits(
  backupId: string | undefined,
): Promise<Record<string, string> | undefined> {
  if (!backupId || !backupId.includes(BACKUP_FILE_NAME)) {
    return undefined;
  }
  let backup: vscode.Uri;
  try {
    backup = vscode.Uri.parse(backupId);
  } catch {
    return undefined;
  }
  try {
    const raw = await vscode.workspace.fs.readFile(backup);
    const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as {
      version?: number;
      edits?: Record<string, string>;
    };
    const edits = parsed?.edits;
    if (!edits || typeof edits !== "object") {
      return undefined;
    }
    await discard(backup);
    return edits;
  } catch {
    // A backup we cannot read is the same as no backup: open the file as-is.
    return undefined;
  }
}

async function discard(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    /* already gone */
  }
}

function fileName(uri: vscode.Uri): string {
  const base = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  return base.length > 0 ? base : uri.fsPath;
}
