import { strict as assert } from "node:assert";
import {
  FakeUri,
  FakeWebviewPanel,
  fakeContext,
  fakeFs,
  loadExtension,
  neverCancelled,
  registeredProvider,
} from "./vscodeMock";

/**
 * Boot the real extension against the fake `vscode` module and open one editor
 * panel, returning both the host-side document and the webview stand-in.
 */
export async function openPanel(
  epubPath: string,
  bytes: Buffer,
): Promise<{ panel: FakeWebviewPanel; document: { uri: FakeUri } }> {
  fakeFs.files.set(FakeUri.file(epubPath).path, bytes);
  const extension = loadExtension();
  extension.activate(fakeContext as never);
  const registered = registeredProvider;
  assert.ok(registered, "the custom editor provider must be registered");
  assert.equal(registered.viewType, "epubReader.reader");
  assert.equal(registered.options.webviewOptions.retainContextWhenHidden, true);

  const uri = FakeUri.file(epubPath);
  const document = await registered.provider.openCustomDocument(uri, {}, neverCancelled);
  const panel = new FakeWebviewPanel();
  await registered.provider.resolveCustomEditor(document, panel as never, neverCancelled);
  return { panel, document };
}
