export function mockTab(partial: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    index: 0,
    groupId: -1,
    windowId: 1,
    selected: false,
    lastAccessed: 0,
    highlighted: false,
    active: false,
    pinned: false,
    frozen: false,
    discarded: false,
    autoDiscardable: true,
    incognito: false,
    ...partial,
  };
}

export function mockResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}
