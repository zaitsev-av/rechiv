export interface KeyValueChange<T> {
  oldValue: T | undefined;
  newValue: T | undefined;
}

export type KeyValueChangeListener<T> = (change: KeyValueChange<T>) => void;

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  subscribe<T>(key: string, listener: KeyValueChangeListener<T>): () => void;
}

type ChromeStorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

interface ChromeStorageChanges {
  addListener(listener: ChromeStorageChangeListener): void;
  removeListener(listener: ChromeStorageChangeListener): void;
}

export class ChromeKeyValueStore implements KeyValueStore {
  constructor(
    private readonly storage: chrome.storage.StorageArea,
    private readonly changes: ChromeStorageChanges,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.storage.get(key);
    return result[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.storage.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.storage.remove(key);
  }

  subscribe<T>(key: string, listener: KeyValueChangeListener<T>): () => void {
    const storageListener: ChromeStorageChangeListener = (changes, areaName) => {
      if (areaName !== "local" || !(key in changes)) return;
      const change = changes[key];
      listener({
        oldValue: change.oldValue as T | undefined,
        newValue: change.newValue as T | undefined,
      });
    };
    this.changes.addListener(storageListener);
    return () => this.changes.removeListener(storageListener);
  }
}

function deserialize<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export class LocalStorageKeyValueStore implements KeyValueStore {
  constructor(
    private readonly storage: Storage,
    private readonly eventTarget: Window,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    return deserialize<T>(this.storage.getItem(key));
  }

  async set<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`Value for ${key} cannot be serialized`);
    }
    this.storage.setItem(key, serialized);
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }

  subscribe<T>(key: string, listener: KeyValueChangeListener<T>): () => void {
    const storageListener = (event: StorageEvent) => {
      if (event.storageArea !== this.storage || event.key !== key) return;
      listener({
        oldValue: deserialize<T>(event.oldValue),
        newValue: deserialize<T>(event.newValue),
      });
    };
    this.eventTarget.addEventListener("storage", storageListener);
    return () => this.eventTarget.removeEventListener("storage", storageListener);
  }
}

function chromeStorageIsAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    chrome.storage?.local !== undefined &&
    chrome.storage.onChanged !== undefined
  );
}

export function createKeyValueStore(): KeyValueStore {
  if (chromeStorageIsAvailable()) {
    return new ChromeKeyValueStore(chrome.storage.local, chrome.storage.onChanged);
  }
  return new LocalStorageKeyValueStore(localStorage, window);
}

export const keyValueStore = createKeyValueStore();
