/** Minimal in-memory IndexedDB covering only what apps/web/src/persistence.ts uses: `open` with
 * `onupgradeneeded`, `createObjectStore`, `transaction`, `objectStore`, `get`, `put`, `getAllKeys`, request
 * `onsuccess`/`onerror`, and transaction `oncomplete`/`onerror`/`onabort`. Events fire asynchronously (microtasks);
 * transactions run in creation order and complete after every request, including requests made in callbacks.
 */
export type FakeIndexedDbOptions = {
  /** `open` throws synchronously, as when storage access is denied. */
  openThrows?: boolean;
  /** The open request fires `onerror`. */
  openFails?: boolean;
  /** Every `put` fails, as when the quota is exceeded; the transaction errors and aborts. */
  writesFail?: boolean;
};

type Handler = (() => void) | null;

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: Handler = null;
}

class FakeDatabase {
  readonly stores = new Map<string, Map<IDBValidKey, unknown>>();
  version = 0;
  upgrading = false;
  constructor(readonly options: FakeIndexedDbOptions) {}
  createObjectStore(name: string) {
    if (!this.upgrading) throw new DOMException('Not in a version change', 'InvalidStateError');
    if (this.stores.has(name)) throw new DOMException(`Object store ${name} exists`, 'ConstraintError');
    this.stores.set(name, new Map());
  }
  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly') {
    return new FakeTransaction(this, typeof names === 'string' ? [names] : names, mode);
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private readonly queue: (() => void)[] = [];
  constructor(
    readonly db: FakeDatabase,
    private readonly names: string[],
    readonly mode: IDBTransactionMode,
  ) {
    for (const name of names) if (!db.stores.has(name)) throw new DOMException(`No object store ${name}`, 'NotFoundError');
    queueMicrotask(() => this.run());
  }
  objectStore(name: string) {
    if (!this.names.includes(name)) throw new DOMException(`${name} is not in this transaction`, 'NotFoundError');
    return new FakeObjectStore(this, this.db.stores.get(name)!);
  }
  request<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.queue.push(() => {
      try {
        request.result = operation();
      } catch (e) {
        request.error = e instanceof DOMException ? e : new DOMException(String(e), 'UnknownError');
        this.error = request.error;
        request.onerror?.();
        return;
      }
      request.onsuccess?.();
    });
    return request;
  }
  private run() {
    // Callbacks may queue further requests; they run before the transaction settles.
    while (this.queue.length && !this.error) this.queue.shift()!();
    if (this.error) {
      this.onerror?.();
      this.onabort?.();
    } else this.oncomplete?.();
  }
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly data: Map<IDBValidKey, unknown>,
  ) {}
  get(key: IDBValidKey) {
    return this.transaction.request(() => this.data.get(key));
  }
  getAllKeys() {
    return this.transaction.request(() => [...this.data.keys()].sort());
  }
  put(value: unknown, key: IDBValidKey) {
    if (this.transaction.mode === 'readonly') throw new DOMException('Read-only transaction', 'ReadOnlyError');
    return this.transaction.request(() => {
      if (this.transaction.db.options.writesFail) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      this.data.set(key, value);
      return key;
    });
  }
}

/** A fresh fake factory with its own databases; `contents()` reads an object store for assertions. */
export function fakeIndexedDb(options: FakeIndexedDbOptions = {}) {
  const databases = new Map<string, FakeDatabase>();
  const calls = { open: 0, upgrades: 0 };
  const factory = {
    open(name: string, version = 1) {
      calls.open++;
      if (options.openThrows) throw new DOMException('Storage access denied', 'SecurityError');
      const request = new FakeOpenRequest();
      queueMicrotask(() => {
        if (options.openFails) {
          request.error = new DOMException('Open failed', 'UnknownError');
          request.onerror?.();
          return;
        }
        const db = databases.get(name) ?? new FakeDatabase(options);
        databases.set(name, db);
        request.result = db;
        if (version > db.version) {
          db.version = version;
          db.upgrading = true;
          calls.upgrades++;
          try {
            request.onupgradeneeded?.();
          } finally {
            db.upgrading = false;
          }
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  const contents = (name = 'game-results-prediction', store = 'entries') =>
    Object.fromEntries(databases.get(name)?.stores.get(store) ?? []) as Record<string, unknown>;
  return { factory: factory as unknown as IDBFactory, databases, calls, contents };
}
