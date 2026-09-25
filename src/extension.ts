import * as vscode from "vscode";
import { cleanupBookCaches } from "./editor/epubDocument";
import { EpubEditorProvider } from "./editor/epubEditorProvider";
import { ReaderStore, RecentBook } from "./editor/storage";

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReaderStore(context.globalState);

  context.subscriptions.push(EpubEditorProvider.register(context, store));
  context.subscriptions.push(
    vscode.commands.registerCommand("epubReader.open", (uri?: vscode.Uri) => openWithReader(uri)),
    vscode.commands.registerCommand("epubReader.continueReading", () => continueReading(store)),
    vscode.commands.registerCommand("epubReader.clearHistory", () => clearHistory(store)),
  );

  // Housekeeping: drop asset caches nobody touched for two weeks.
  void cleanupBookCaches(context);
}

export function deactivate(): void {
  // Nothing global to tear down: sessions clean up with their panels.
}

async function openWithReader(uri?: vscode.Uri): Promise<void> {
  let target = uri;
  if (!target) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "打开",
      filters: { "EPUB 电子书": ["epub"] },
    });
    target = picked?.[0];
  }
  if (!target) {
    return;
  }
  await vscode.commands.executeCommand("vscode.openWith", target, EpubEditorProvider.viewType);
}

async function continueReading(store: ReaderStore): Promise<void> {
  const recents = store.recents();
  if (recents.length === 0) {
    void vscode.window.showInformationMessage("还没有阅读记录，先打开一本 EPUB 吧。");
    return;
  }

  const existing: RecentBook[] = [];
  for (const recent of recents) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(recent.fsPath));
      existing.push(recent);
    } catch {
      // The book moved or was deleted: keep the record, skip it in the picker.
    }
  }
  if (existing.length === 0) {
    void vscode.window.showInformationMessage("阅读记录里的书都找不到了。");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    existing.map((recent) => ({
      label: recent.title || recent.fsPath,
      description: recent.chapterTitle ? `读至 ${recent.chapterTitle}` : `第 ${recent.chapter + 1} 节`,
      detail: recent.fsPath,
      recent,
    })),
    { placeHolder: "继续阅读", matchOnDetail: true },
  );
  if (!picked) {
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(picked.recent.fsPath),
    EpubEditorProvider.viewType,
  );
}

async function clearHistory(store: ReaderStore): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    "确定要清除所有 EPUB 阅读进度、书签与阅读记录吗？",
    { modal: true },
    "清除",
  );
  if (confirmed !== "清除") {
    return;
  }
  store.clearHistory();
  void vscode.window.showInformationMessage("阅读记录已清除。");
}
