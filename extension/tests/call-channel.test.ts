import { describe, expect, it, vi } from "vitest";
import { CallChannel } from "../src/background/call-channel";
import type { CallPresence, SttApiClient } from "../src/shared/api-client";

const call = (recording = false): CallPresence => ({
  platform: "Яндекс Телемост",
  url: "https://telemost.yandex.ru/j/1",
  title: "Дейли",
  recording,
});

function setup(calls: (CallPresence | null)[]) {
  const describeCall = vi.fn(async () => (calls.length > 1 ? calls.shift() : calls[0]) ?? null);
  const pollCalls = vi.fn<SttApiClient["pollCalls"]>().mockResolvedValue({});
  const onCommand = vi.fn(async () => undefined);
  const delay = vi.fn(async () => undefined);
  const channel = new CallChannel({
    api: () => ({ pollCalls }) as unknown as SttApiClient,
    describe: describeCall,
    onCommand,
    delay,
  });
  return { channel, describeCall, pollCalls, onCommand, delay };
}

describe("CallChannel", () => {
  it("без созвона ничего не отправляет и останавливается", async () => {
    const { channel, pollCalls } = setup([null]);
    await channel.ensure();
    expect(pollCalls).not.toHaveBeenCalled();
    expect(channel.running).toBe(false);
  });

  it("передаёт состояние и выполняет команду из ответа", async () => {
    const { channel, pollCalls, onCommand } = setup([call(), call(true), null]);
    pollCalls.mockResolvedValueOnce({ command: "start" });
    await channel.ensure();
    expect(pollCalls.mock.calls.map((args) => [args[0], args[1]])).toEqual([
      [call(), 20],
      [call(true), 20],
      [null, 0],
    ]);
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("start", false);
  });

  it("передаёт признак автозаписи", async () => {
    const { channel, pollCalls, onCommand } = setup([call(), null]);
    pollCalls.mockResolvedValueOnce({ command: "start", auto: true });
    await channel.ensure();
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("start", true);
  });

  it("повторяет опрос, когда desktop недоступен", async () => {
    const { channel, pollCalls, delay } = setup([call(), call(), null]);
    pollCalls.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await channel.ensure();
    expect(delay).toHaveBeenNthCalledWith(1, 5000);
    expect(pollCalls).toHaveBeenCalledTimes(3);
  });

  it("не опрашивает чаще раза в секунду, если desktop отвечает сразу", async () => {
    const { channel, delay } = setup([call(), call(), null]);
    await channel.ensure();
    expect(delay.mock.calls).toEqual([[1000], [1000]]);
  });

  it("refresh прерывает ожидание и сразу отправляет новое состояние", async () => {
    const { channel, pollCalls, describeCall } = setup([call(), call(true), null]);
    pollCalls.mockImplementationOnce(
      (_call, _wait, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const running = channel.ensure();
    await vi.waitFor(() => expect(pollCalls).toHaveBeenCalledTimes(1));
    channel.refresh();
    await running;
    expect(describeCall).toHaveBeenCalledTimes(3);
    expect(pollCalls.mock.calls[1][0]).toEqual(call(true));
  });

  it("ошибка команды не останавливает канал", async () => {
    const { channel, pollCalls, onCommand } = setup([call(), call(), null]);
    pollCalls.mockResolvedValueOnce({ command: "stop" });
    onCommand.mockRejectedValueOnce(new Error("нет вкладки"));
    await channel.ensure();
    expect(pollCalls).toHaveBeenLastCalledWith(null, 0);
  });

  it("ensure не запускает второй цикл", async () => {
    const { channel, describeCall } = setup([null]);
    await Promise.all([channel.ensure(), channel.ensure()]);
    expect(describeCall).toHaveBeenCalledTimes(1);
  });
});
