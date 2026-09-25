/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Module from "node:module";
import * as path from "node:path";

/**
 * A deliberately small stand-in for the `vscode` module, good enough to boot
 * the real extension host code (provider + session + storage) in a plain Node
 * process. It exists so the message loop, the render pipeline and the disk
 * cache can be exercised end to end without a GUI.
 */

export const FileType = { Unknown: 0, File: 1, Directory: 2 };

export class FakeUri {
  constructor(readonly scheme: string, readonly path: string) {}

  static file(filePath: string): FakeUri {
    return new FakeUri("file", filePath.replace(/\\/g, "/"));
  }

  static parse(value: string): FakeUri {
    const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value);
    return match ? new FakeUri(match[1].toLowerCase(), match[2]) : new FakeUri("file", value);
  }

  static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    const normalized = segments.map((segment) => segment.replace(/\\/g, "/"));
    return new FakeUri(base.scheme, path.posix.join(base.path, ...normalized));
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }

  with(changes: { path?: string; scheme?: string }): FakeUri {
    return new FakeUri(changes.scheme ?? this.scheme, changes.path ?? this.path);
  }
}

export class FakeFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();

  async readFile(uri: FakeUri): Promise<Uint8Array> {
    const data = this.files.get(uri.path);
    if (!data) {
      throw new Error(`ENOENT: ${uri.path}`);
    }
    return data;
  }

  async writeFile(uri: FakeUri, content: Uint8Array): Promise<void> {
    this.files.set(uri.path, content);
    this.directories.add(path.posix.dirname(uri.path));
  }

  async createDirectory(uri: FakeUri): Promise<void> {
    this.directories.add(uri.path);
  }

  async stat(uri: FakeUri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
    const data = this.files.get(uri.path);
    if (data) {
      return { type: FileType.File, ctime: Date.now(), mtime: Date.now(), size: data.length };
    }
    if (this.directories.has(uri.path)) {
      return { type: FileType.Directory, ctime: Date.now(), mtime: Date.now(), size: 0 };
    }
    throw new Error(`ENOENT: ${uri.path}`);
  }

  async readDirectory(uri: FakeUri): Promise<[string, number][]> {
    const base = uri.path.replace(/\/$/, "");
    const prefix = `${base}/`;
    const found = new Map<string, number>();
    const consider = (candidate: string, type: number): void => {
      if (!candidate.startsWith(prefix)) {
        return;
      }
      const rest = candidate.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (name.length > 0) {
        found.set(name, slash < 0 ? type : FileType.Directory);
      }
    };
    for (const file of this.files.keys()) {
      consider(file, FileType.File);
    }
    for (const directory of this.directories) {
      consider(directory, FileType.Directory);
    }
    if (found.size === 0 && !this.directories.has(base)) {
      throw new Error(`ENOENT: ${uri.path}`);
    }
    return Array.from(found.entries());
  }

  async delete(uri: FakeUri, _options?: { recursive?: boolean }): Promise<void> {
    const prefix = `${uri.path}/`;
    for (const key of Array.from(this.files.keys())) {
      if (key === uri.path || key.startsWith(prefix)) {
        this.files.delete(key);
      }
    }
    for (const key of Array.from(this.directories)) {
      if (key === uri.path || key.startsWith(prefix)) {
        this.directories.delete(key);
      }
    }
  }

  async copy(source: FakeUri, target: FakeUri): Promise<void> {
    const data = this.files.get(source.path);
    if (data) {
      await this.writeFile(target, data);
    }
  }

  async rename(): Promise<void> {
    throw new Error("not implemented");
  }
}

class FakeMemento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  clear(): void {
    this.store.clear();
  }
}

export class FakeWebview {
  options: unknown = {};
  html = "";
  readonly cspSource = "fake-csp-source:";
  readonly posted: any[] = [];
  private listener: ((message: any) => unknown) | undefined;

  asWebviewUri(uri: FakeUri): FakeUri {
    return new FakeUri("webview", uri.path);
  }

  postMessage(message: any): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (message: any) => unknown): { dispose(): void } {
    this.listener = listener;
    return { dispose: () => undefined };
  }

  /** Pretend the client sent a message and wait for the host to handle it. */
  async send(message: any): Promise<void> {
    if (!this.listener) {
      throw new Error("no message listener registered");
    }
    await this.listener(message);
  }

  count(): number {
    return this.posted.length;
  }

  /**
   * The session handles messages without blocking the caller, so tests wait for
   * the message they expect instead of assuming it is already there.
   */
  async waitFor<T = any>(
    type: string,
    options: { after?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const after = options.after ?? 0;
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    for (;;) {
      for (let index = after; index < this.posted.length; index++) {
        if (this.posted[index].type === type) {
          return this.posted[index] as T;
        }
      }
      if (Date.now() > deadline) {
        const seen = this.posted.map((message) => message.type).join(", ");
        throw new Error(`timed out waiting for a "${type}" message (saw: ${seen || "none"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  messages<T = any>(type: string): T[] {
    return this.posted.filter((message) => message.type === type);
  }

  last<T = any>(type: string): T | undefined {
    const all = this.messages<T>(type);
    return all[all.length - 1];
  }
}

export class FakeWebviewPanel {
  title = "";
  readonly webview = new FakeWebview();
  private disposeListener: (() => unknown) | undefined;
  disposed = false;

  onDidDispose(listener: () => unknown): { dispose(): void } {
    this.disposeListener = listener;
    return { dispose: () => undefined };
  }

  dispose(): void {
    this.disposed = true;
    this.disposeListener?.();
  }
}

export const fakeFs = new FakeFileSystem();
export const globalState = new FakeMemento();
export const configurationStore = new Map<string, unknown>();
export const openedExternal: string[] = [];
export const registeredCommands = new Map<string, (...args: any[]) => unknown>();
export const quickPickAnswers: any[] = [];

export interface RegisteredEditorProvider {
  viewType: string;
  provider: any;
  options: any;
}

export let registeredProvider: RegisteredEditorProvider | undefined;

export const fakeContext = {
  subscriptions: [] as { dispose(): void }[],
  globalState,
  workspaceState: new FakeMemento(),
  extensionUri: FakeUri.file("D:/ext"),
  extensionPath: "D:/ext",
  globalStorageUri: FakeUri.file("D:/storage"),
  storageUri: FakeUri.file("D:/storage/workspace"),
  asAbsolutePath: (relative: string) => path.posix.join("D:/ext", relative),
};

export const vscodeMock: Record<string, unknown> = {
  Uri: FakeUri,
  FileType,
  EventEmitter: class {
    private readonly listeners: ((value: unknown) => unknown)[] = [];
    event = (listener: (value: unknown) => unknown): { dispose(): void } => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(value: unknown): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose(): void {
      this.listeners.length = 0;
    }
  },
  CancellationError: class extends Error {},
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  env: {
    openExternal: async (uri: FakeUri) => {
      openedExternal.push(uri.toString());
      return true;
    },
  },
  window: {
    registerCustomEditorProvider(viewType: string, provider: any, options: any) {
      registeredProvider = { viewType, provider, options };
      return { dispose: () => undefined };
    },
    showOpenDialog: async () => undefined,
    showQuickPick: async (items: any) => {
      return quickPickAnswers.length > 0 ? quickPickAnswers.shift() : (items as any[])[0];
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_options: unknown, task: any) =>
      task({ report: () => undefined }, { isCancellationRequested: false }),
  },
  workspace: {
    fs: fakeFs,
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) =>
        configurationStore.has(key) ? configurationStore.get(key) : fallback,
      update: async (key: string, value: unknown) => {
        configurationStore.set(key, value);
      },
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
  commands: {
    registerCommand(id: string, handler: (...args: any[]) => unknown) {
      registeredCommands.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: async () => undefined,
  },
};

/*
 * `Module._load` is a getter-only property on modern Node, so the `vscode`
 * resolution is intercepted on `Module.prototype.require`, which is what every
 * compiled CommonJS module calls when it runs `require("vscode")`.
 */
const modulePrototype = Module.prototype as unknown as {
  require(request: string): unknown;
};
const originalRequire = modulePrototype.require;
modulePrototype.require = function patchedRequire(this: unknown, request: string): unknown {
  if (request === "vscode") {
    return vscodeMock;
  }
  return originalRequire.call(this, request);
};

/** Load the compiled extension with the mock already installed. */
export function loadExtension(): typeof import("../../extension") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../extension");
}

/** A cancellation token that never cancels. */
export const neverCancelled = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

/** Wipe everything the fake host keeps between tests. */
export function resetHostState(): void {
  globalState.clear();
  configurationStore.clear();
  openedExternal.length = 0;
  quickPickAnswers.length = 0;
  fakeFs.files.clear();
  fakeFs.directories.clear();
}

/** Collect extracted asset paths from the fake file system. */
export function extractedAssets(): string[] {
  return Array.from(fakeFs.files.keys()).filter((key) => key.startsWith("D:/storage/books/"));
}
