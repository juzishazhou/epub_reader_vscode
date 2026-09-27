import { strict as assert } from "node:assert";
import type { EpubDocument } from "../../editor/epubDocument";
import {
  FakeUri,
  FakeWebviewPanel,
  fakeContext,
  fakeFs,
  loadExtension,
  neverCancelled,
  registeredProvider,
  RegisteredEditorProvider,
} from "./vscodeMock";

/** The registered custom editor provider, after `activate`. */
export function provider(): RegisteredEditorProvider {
  const extension = loadExtension();
  extension.activate(fakeContext as never);
  const registered = registeredProvider;
  assert.ok(registered, "the custom editor provider must be registered");
  assert.equal(registered.viewType, "epubReader.reader");
  assert.equal(registered.options.webviewOptions.retainContextWhenHidden, true);
  return registered;
}

/** Open (or re-open) one `.epub` as a custom document. */
export async function openDocument(
  epubPath: string,
  bytes: Buffer,
  openContext: { backupId?: string } = {},
): Promise<EpubDocument> {
  fakeFs.files.set(FakeUri.file(epubPath).path, bytes);
  const registered = provider();
  const uri = FakeUri.file(epubPath);
  return registered.provider.openCustomDocument(uri, openContext, neverCancelled) as Promise<EpubDocument>;
}

/** Attach one more editor panel to an already open document. */
export async function attachPanel(document: EpubDocument): Promise<FakeWebviewPanel> {
  const panel = new FakeWebviewPanel();
  await registeredProvider!.provider.resolveCustomEditor(document, panel as never, neverCancelled);
  return panel;
}

/**
 * Boot the real extension against the fake `vscode` module and open one editor
 * panel, returning both the host-side document and the webview stand-in.
 */
export async function openPanel(
  epubPath: string,
  bytes: Buffer,
  openContext: { backupId?: string } = {},
): Promise<{ panel: FakeWebviewPanel; document: EpubDocument }> {
  const document = await openDocument(epubPath, bytes, openContext);
  const panel = await attachPanel(document);
  return { panel, document };
}
