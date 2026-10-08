import { describe, expect, it } from "vitest";
import { speakerInitials } from "../src/shared/speaker-initials";

describe("speakerInitials", () => {
  it("берёт первые буквы двух первых слов", () => {
    expect(speakerInitials("Борис Ковалёв")).toBe("БК");
    expect(speakerInitials("Вера Лапина-Носова Петровна")).toBe("ВЛ");
  });

  it("для одного слова — одна буква", () => {
    expect(speakerInitials("maksim")).toBe("M");
  });

  it("пропускает знаки и пустые части", () => {
    expect(speakerInitials("  (Вы) Олег  ")).toBe("ВО");
    expect(speakerInitials("— Глеб")).toBe("Г");
  });

  it("неизвестному участнику и пустому имени — вопрос", () => {
    expect(speakerInitials("Неизвестный участник", "unknown")).toBe("?");
    expect(speakerInitials("   ")).toBe("?");
  });
});
