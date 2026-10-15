const RPC_PREFIX = "/$rpc/google.rtc.meetings.v1.";

export type RpcListener = {
  request(method: string, body: Uint8Array): void;
  response(method: string, body: ArrayBuffer): void;
};

export function watchMeetRpc(listener: RpcListener): void {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = rpcMethod(input instanceof Request ? input.url : String(input));
      if (method) safely(() => notifyRequest(listener, method, init?.body));

      const response = await originalFetch(input, init);
      if (method) {
        void response
          .clone()
          .arrayBuffer()
          .then((body) => listener.response(method, body))
          .catch(() => undefined);
      }

      return response;
    };
  }

  const xhr = globalThis.XMLHttpRequest?.prototype;
  if (!xhr) return;

  const originalOpen = xhr.open;
  const originalSend = xhr.send;
  const methods = new WeakMap<XMLHttpRequest, string>();

  xhr.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["open"]>) {
    const method = rpcMethod(String(args[1]));
    if (method) methods.set(this, method);

    return originalOpen.apply(this, args);
  } as XMLHttpRequest["open"];

  xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const method = methods.get(this);
    if (method) {
      safely(() => notifyRequest(listener, method, body));
      this.addEventListener("load", () => safely(() => notifyXhrResponse(listener, method, this)));
    }

    return originalSend.call(this, body);
  };
}

function rpcMethod(url: string): string | null {
  const index = url.indexOf(RPC_PREFIX);

  return index === -1 ? null : (url.slice(index + RPC_PREFIX.length).split("?")[0] ?? null);
}

function notifyRequest(listener: RpcListener, method: string, body: unknown): void {
  if (typeof body === "string") listener.request(method, new TextEncoder().encode(body));
  else if (body instanceof ArrayBuffer) listener.request(method, new Uint8Array(body));
  else if (ArrayBuffer.isView(body)) {
    listener.request(method, new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
}

function notifyXhrResponse(listener: RpcListener, method: string, xhr: XMLHttpRequest): void {
  if (xhr.responseType === "" || xhr.responseType === "text") {
    const bytes = new TextEncoder().encode(xhr.responseText);
    listener.response(
      method,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  } else if (xhr.response instanceof ArrayBuffer) {
    listener.response(method, xhr.response);
  }
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Разбор не должен мешать запросам страницы.
  }
}
