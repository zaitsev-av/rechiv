import { vi } from "vitest";

// storage.session настоящий: на нём состояние, переживающее рестарт SW.
export const sessionStore: Record<string, unknown> = {};

const storageMock = {
  local: {
    get: vi.fn().mockResolvedValue({}),
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
  onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
  getManifest: vi.fn(() => ({ version: "0.4.1" })),
};

const actionMock = {
  setBadgeText: vi.fn().mockResolvedValue(undefined),
  setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
  setIcon: vi.fn().mockResolvedValue(undefined),
};

const notificationsMock = {
  create: vi.fn().mockResolvedValue("notification-id"),
  onClicked: { addListener: vi.fn() },
  onButtonClicked: { addListener: vi.fn() },
};

const tabsMock = {
  onRemoved: { addListener: vi.fn() },
  onUpdated: { addListener: vi.fn() },
  query: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockRejectedValue(new Error("No tab with id")),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue({}),
};

const alarmsMock = {
  create: vi.fn(),
  clear: vi.fn().mockResolvedValue(true),
  onAlarm: { addListener: vi.fn() },
};

(globalThis as any).chrome = {
  storage: storageMock,
  runtime: runtimeMock,
  action: actionMock,
  notifications: notificationsMock,
  tabs: tabsMock,
  alarms: alarmsMock,
};
