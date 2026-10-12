import { vi } from "vitest";
import { mockTab } from "./mocks";

// storage.session настоящий: на нём состояние, переживающее рестарт SW.
export const sessionStore: Record<string, unknown> = {};

const storageMock = {
  local: {
    get: vi
      .fn<
        (keys?: Parameters<typeof chrome.storage.local.get>[0]) => Promise<Record<string, unknown>>
      >()
      .mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  session: {
    get: vi.fn(async (key: string) => (key in sessionStore ? { [key]: sessionStore[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(sessionStore, items);
    }),
  },
  onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
};

const runtimeMock = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onMessage: {
    addListener: vi.fn<typeof chrome.runtime.onMessage.addListener>(),
    removeListener: vi.fn<typeof chrome.runtime.onMessage.removeListener>(),
  },
  getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
  getManifest: vi.fn(() => ({ version: "0.4.1" })),
};

const actionMock = {
  setBadgeText: vi.fn().mockResolvedValue(undefined),
  setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
  setIcon: vi.fn().mockResolvedValue(undefined),
};

const notificationsMock = {
  create: vi
    .fn<
      (notificationId: string, options: chrome.notifications.NotificationOptions) => Promise<string>
    >()
    .mockResolvedValue("notification-id"),
  onClicked: { addListener: vi.fn() },
  onButtonClicked: { addListener: vi.fn() },
};

const tabsMock = {
  onRemoved: { addListener: vi.fn() },
  onUpdated: { addListener: vi.fn() },
  query: vi
    .fn<(queryInfo: Parameters<typeof chrome.tabs.query>[0]) => Promise<chrome.tabs.Tab[]>>()
    .mockResolvedValue([]),
  get: vi
    .fn<(tabId: number) => Promise<chrome.tabs.Tab>>()
    .mockRejectedValue(new Error("No tab with id")),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  create: vi
    .fn<(properties: Parameters<typeof chrome.tabs.create>[0]) => Promise<chrome.tabs.Tab>>()
    .mockResolvedValue(mockTab()),
  update: vi
    .fn<
      (
        tabId: number,
        properties: Parameters<typeof chrome.tabs.update>[0],
      ) => Promise<chrome.tabs.Tab | undefined>
    >()
    .mockResolvedValue(mockTab()),
};

const alarmsMock = {
  create: vi.fn(),
  clear: vi.fn().mockResolvedValue(true),
  onAlarm: { addListener: vi.fn() },
};

export const chromeMock = {
  storage: storageMock,
  runtime: runtimeMock,
  action: actionMock,
  notifications: notificationsMock,
  tabs: tabsMock,
  alarms: alarmsMock,
};

// Chrome должен сохраняться после vi.unstubAllGlobals() в отдельных тестах.
Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  writable: true,
  configurable: true,
  enumerable: true,
});
