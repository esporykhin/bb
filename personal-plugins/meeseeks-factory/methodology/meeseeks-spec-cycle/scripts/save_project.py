#!/usr/bin/env python3
"""Распаковка выгрузки файла проекта из Google Drive в локальный xlsx.

Ответ `download_file_content` вложен дважды: список блоков MCP, в текстовом
блоке которого лежит JSON, а уже в нём — base64 тела файла. Один декод base64
поверх сырого ответа даёт мусор, поэтому разбор вынесен в скрипт: снимок на
прогон один, и ошибка распаковки должна быть видна здесь, а не через два шага
на разборе листа.

На вход принимается путь к файлу с ответом MCP или `-` для stdin. Формы, которые
разбираются: список блоков MCP, объект с полем `content`/`data`/`fileContent`,
голая base64-строка. Вложенность разбирается на любую глубину.

Результат проверяется открытием: файл, который не открывается openpyxl,
не сохраняется — иначе прогон уходит дальше с битым снимком.

Usage:
    python scripts/save_project.py <результат MCP> run/<такт>/project.xlsx
    python scripts/save_project.py - run/<такт>/project.xlsx --json

Exit codes:
    0 — снимок сохранён
    2 — вход не разобран либо результат не открывается как xlsx
"""

import argparse
import base64
import binascii
import json
import sys
from pathlib import Path

ZIP_MAGIC = b"PK\x03\x04"
CONTENT_KEYS = ("content", "data", "fileContent", "file_content", "body", "bytes")
MAX_DEPTH = 8


def read_source(src):
    if src == "-":
        return sys.stdin.read()
    p = Path(src)
    if not p.exists():
        raise SystemExit(f"Нет файла с ответом MCP: {p}")
    return p.read_text(encoding="utf-8", errors="replace")


def try_b64(value):
    """base64-строка -> байты xlsx, иначе None."""
    if not isinstance(value, str):
        return None
    s = "".join(value.split())
    if len(s) < 64:
        return None
    try:
        raw = base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return None
    return raw if raw.startswith(ZIP_MAGIC) else None


def extract(node, depth=0):
    """Обход вложенности до первой строки, декодируемой в zip-контейнер."""
    if depth > MAX_DEPTH:
        return None

    if isinstance(node, str):
        raw = try_b64(node)
        if raw is not None:
            return raw
        stripped = node.strip()
        if stripped[:1] in ("{", "["):
            try:
                return extract(json.loads(stripped), depth + 1)
            except json.JSONDecodeError:
                return None
        return None

    if isinstance(node, dict):
        for key in CONTENT_KEYS:              # приоритет известным полям
            if key in node:
                found = extract(node[key], depth + 1)
                if found is not None:
                    return found
        for value in node.values():
            found = extract(value, depth + 1)
            if found is not None:
                return found
        return None

    if isinstance(node, (list, tuple)):
        for item in node:
            found = extract(item, depth + 1)
            if found is not None:
                return found

    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="файл с ответом MCP или '-' для stdin")
    ap.add_argument("dest", help="куда сохранить xlsx, например run/T-01/project.xlsx")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    text = read_source(a.source)
    raw = extract(text)
    if raw is None:
        print(
            "Тело файла не найдено в ответе MCP.\n"
            "Ожидались: список блоков MCP с текстовым блоком, объект с полем "
            "content/data, либо base64-строка. Проверить, что вызывался "
            "download_file_content с exportMimeType на xlsx: экспорт в text/csv "
            "даёт не zip-контейнер и здесь не примется.",
            file=sys.stderr,
        )
        return 2

    dest = Path(a.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(raw)

    try:
        import openpyxl

        wb = openpyxl.load_workbook(dest, data_only=True, read_only=True)
        sheets = list(wb.sheetnames)
        wb.close()
    except Exception as e:  # noqa: BLE001
        dest.unlink(missing_ok=True)
        print(f"Сохранённый файл не открывается как xlsx: {e}", file=sys.stderr)
        return 2

    result = {"path": str(dest), "bytes": len(raw), "sheets": sheets}
    if a.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Снимок: {dest} ({len(raw)} байт)")
        print(f"Листы: {', '.join(sheets)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
