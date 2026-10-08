import { beforeEach, describe, expect, it } from "vitest";
import { DomParser } from "../src/content/dom-parser";

describe("DomParser", () => {
  let parser: DomParser;

  beforeEach(() => {
    document.body.innerHTML = "";
    parser = new DomParser();
  });

  it("finds participant name by stream id", () => {
    document.body.innerHTML = `
      <div class="participant">
        <video id="video-1"></video>
        <span class="participant-name">Глеб Носов</span>
      </div>
    `;
    const video = document.getElementById("video-1") as HTMLVideoElement;
    Object.defineProperty(video, "srcObject", { value: { id: "stream-123" } });
    const name = parser.findParticipantName("stream-123");
    expect(name).toBe("Глеб Носов");
  });

  it("finds participant name stripping remote- prefix", () => {
    document.body.innerHTML = `
      <div class="sc-tile">
        <div><video id="video-r"></video></div>
        <div><span class="ant-typography ant-typography-ellipsis-single-line">Глеб Носов FE</span></div>
      </div>
    `;
    const video = document.getElementById("video-r") as HTMLVideoElement;
    Object.defineProperty(video, "srcObject", { value: { id: "abc123" } });
    const name = parser.findParticipantName("remote-abc123");
    expect(name).toBe("Глеб Носов FE");
  });

  it("returns null when no match found", () => {
    const name = parser.findParticipantName("nonexistent");
    expect(name).toBeNull();
  });

  it("generates slug from Russian name", () => {
    expect(DomParser.slugify("Андрей Грачёв")).toBe("andrey-grachyov");
  });

  it("generates slug from English name", () => {
    expect(DomParser.slugify("John Doe")).toBe("john-doe");
  });

  it("getAllParticipantNames returns all visible names", () => {
    document.body.innerHTML = `
      <div class="sc-tile">
        <div><video></video></div>
        <div><span class="ant-typography ant-typography-ellipsis-single-line">Глеб Носов</span></div>
      </div>
      <div class="sc-tile">
        <div><video></video></div>
        <div><span class="ant-typography ant-typography-ellipsis-single-line">Павел Рябов</span></div>
      </div>
    `;
    const names = parser.getAllParticipantNames();
    expect(names).toHaveLength(2);
    expect(names).toContain("Глеб Носов");
    expect(names).toContain("Павел Рябов");
  });

  it("finds names in LiveKit tiles when participant cameras are off", () => {
    document.body.innerHTML = `
      <div class="lk-participant-tile" data-lk-participant-identity="user-1">
        <span data-lk-participant-name>Вера Лапина</span>
      </div>
    `;

    expect(parser.getAllParticipantNames()).toEqual(["Вера Лапина"]);
  });

  it("finds and cleans the local participant label", () => {
    document.body.innerHTML = `
      <div data-lk-local-participant="true">
        <span data-lk-participant-name>Олег Ветров (Вы)</span>
      </div>
    `;

    expect(parser.getLocalParticipantName()).toBe("Олег Ветров");
  });
});
