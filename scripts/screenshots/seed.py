#!/usr/bin/env python3
"""Заполняет каталог данных Rechiv вымышленными созвонами для скриншотов документации.

    python3 scripts/screenshots/seed.py <каталог данных>

Имена, тексты и ссылки придуманы. Папки без срока хранения и без автосаммари, чтобы
приложение ничего не удаляло и не ходило в LLM, пока идёт съёмка.
"""

from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

TZ = timezone(timedelta(hours=3))
NOW = datetime(2026, 10, 23, 18, 0, tzinfo=TZ)

PEOPLE = {
    "boris": "Борис Ковалёв",
    "vera": "Вера Лапина",
    "oleg": "Олег Ветров",
    "gleb": "Глеб Носов",
    "local": "Вы",
}

FOLDERS = [
    {"id": "f-daily", "name": "Дейли", "color": 0,
     "rules": [{"url": "https://telemost.yandex.ru/j/00000000000001"}],
     "settings": {"titleTemplate": "Дейли {date} {weekday}"}},
    {"id": "f-product", "name": "Продукт", "color": 2, "rules": [], "settings": {}},
    {"id": "f-one", "name": "1:1", "color": 4, "rules": [], "settings": {}},
]

DIALOG = [
    ("vera", "Всем привет! Давайте быстро пройдёмся по статусу релиза, а потом обсудим онбординг."),
    ("boris", "Привет. Сборка релиза в CI готова: тег собирает приложение на macOS-раннере и выкладывает образ."),
    ("vera", "Сколько занимает сборка?"),
    ("boris", "Без кэша около четырёх минут, дольше всего собирается ffmpeg. С кэшем выйдет минута-две."),
    ("oleg", "Отлично. А что с подписью? Пользователи увидят предупреждение при первом запуске?"),
    ("boris", "Да, пока подпись без Developer ID. В README опишем, как открыть приложение через контекстное меню."),
    ("gleb", "Я бы ещё добавил скриншоты в README, сейчас непонятно, как всё выглядит."),
    ("vera", "Согласна. Глеб, возьмёшь скриншоты? Только на вымышленных данных, без реальных созвонов."),
    ("gleb", "Возьму. Сделаю светлую и тёмную тему, чтобы GitHub показывал нужную."),
    ("oleg", "По онбордингу: расширение пока ставится как распакованное. Это барьер для обычных людей."),
    ("vera", "Давайте вынесем Web Store в отдельную задачу и решим после первых отзывов."),
    ("local", "Тогда фиксирую: релиз-кандидат в пятницу, скриншоты к нему, Web Store — после."),
    ("boris", "Договорились. Я поставлю пробный тег и проверю образ на чистой машине."),
    ("vera", "Спасибо всем, до завтра!"),
]

SUMMARY = """# Дейли: релиз и онбординг

## Итоги

- Сборка релиза в CI готова: тег собирает приложение и выкладывает `.dmg`.
- Без кэша сборка занимает около четырёх минут, с кэшем — одну-две.
- Подписи Developer ID пока нет: в README опишем, как открыть приложение при первом запуске.

## Решения

- Релиз-кандидат — в пятницу.
- Публикацию расширения в Chrome Web Store выносим в отдельную задачу.

## Задачи

- **Борис Ковалёв** — поставить пробный тег и проверить образ на чистой машине.
- **Глеб Носов** — скриншоты для README в светлой и тёмной теме.
- **Олег Ветров** — собрать вопросы по онбордингу расширения.

## Риски

- Распакованное расширение в режиме разработчика может отпугнуть новых пользователей.
"""

OTHER_CALLS = [
    ("f-daily", "Дейли 22.10.2026 среда", 1, 9, ["boris", "vera", "oleg", "gleb"]),
    ("f-product", "Планирование квартала", 1, 52, ["vera", "oleg"]),
    ("f-one", "1:1 с Верой", 2, 31, ["vera"]),
    ("f-daily", "Дейли 21.10.2026 вторник", 2, 11, ["boris", "vera", "oleg", "gleb"]),
    ("", "Созвон с дизайнером", 3, 44, ["gleb"]),
    ("f-product", "Разбор обратной связи", 4, 38, ["vera", "oleg", "boris"]),
    ("f-daily", "Дейли 20.10.2026 понедельник", 3, 14, ["boris", "vera", "oleg"]),
]


def iso(value: datetime) -> str:
    return value.isoformat()


def clock(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def participants(keys: list[str]) -> dict:
    result = {"local": {"speakerId": "local", "name": PEOPLE["local"]}}
    for key in keys:
        result[key] = {"speakerId": key, "name": PEOPLE[key]}
    return result


def write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def session(root: Path, session_id: str, folder: str, title: str, started: datetime,
            minutes: int, keys: list[str]) -> Path:
    directory = root / "sessions" / session_id
    finished = started + timedelta(minutes=minutes)
    meta = {
        "sessionId": session_id,
        "status": "completed",
        "callUrl": "https://telemost.yandex.ru/j/00000000000001",
        "title": title,
        "createdAt": iso(started),
        "finishedAt": iso(finished),
        "participants": participants(keys),
        "chunksCount": minutes * 4,
        "processedChunks": minutes * 4,
        "failedChunks": 0,
        "lastChunkAt": iso(finished),
        "uploadToken": uuid.uuid4().hex,
        "nextChunkBySpeaker": {},
    }
    if folder:
        meta["folderId"] = folder
    write(directory / "meta.json", meta)
    return directory


def transcript(session_id: str, started: datetime, keys: list[str], dialog, minutes: int) -> dict:
    # Реплики раскиданы по всему созвону: длительность в списке совпадает с meta.json.
    segments = []
    step = minutes * 60 // len(dialog)
    for index, (key, text) in enumerate(dialog):
        at = 4 + index * step
        length = max(3, len(text.split()) // 2)
        segments.append({
            "speaker": PEOPLE[key], "speakerId": key,
            "start": clock(at), "end": clock(at + length), "text": text,
        })
    at = minutes * 60
    return {
        "sessionId": session_id,
        "date": started.date().isoformat(),
        "callUrl": "https://telemost.yandex.ru/j/00000000000001",
        "recordingStarted": iso(started),
        "duration": clock(at),
        "participants": [{"speakerId": k, "name": PEOPLE[k]} for k in ["local", *keys]],
        "segments": segments,
    }


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1])
    write(root / "folders.json", {"folders": FOLDERS})
    (root / "onboarding_shown").write_text("", encoding="utf-8")

    main_id = "11111111-1111-4111-8111-111111111111"
    started = NOW.replace(hour=10, minute=0)
    keys = ["boris", "vera", "oleg", "gleb"]
    directory = session(root, main_id, "f-daily", "Дейли 23.10.2026 четверг", started, 12, keys)
    write(directory / "result.json", transcript(main_id, started, keys, DIALOG, 12))
    write(directory / "summary.json", {
        "content": SUMMARY, "createdAt": iso(started + timedelta(minutes=14)),
        "model": "Qwen3-235B", "chunked": False,
    })

    for index, (folder, title, days, minutes, people) in enumerate(OTHER_CALLS):
        other_id = f"22222222-2222-4222-8222-{index:012d}"
        other_started = NOW - timedelta(days=days, hours=index % 3 * 2 + 3)
        directory = session(root, other_id, folder, title, other_started, minutes, people)
        lines = [(people[i % len(people)], text) for i, (_, text) in enumerate(DIALOG[:4])]
        write(directory / "result.json", transcript(other_id, other_started, people, lines, minutes))

    print(main_id)


if __name__ == "__main__":
    main()
