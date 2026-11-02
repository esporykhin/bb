#!/usr/bin/env python3
"""Сборка сводного xlsx-патча прогона из run/state.json.

Три листа: «Развилки» (новые строки), «Задачи» (изменённая колонка «Статус»),
«Подзадачи» (новые строки). Зелёная заливка — добавлено, жёлтая — изменено.

Строка листа «Задачи» переносится всеми двенадцатью колонками: она помечена
«изменено» и применяется целиком, пропущенная колонка затрёт значение пустотой.

Usage:
    python scripts/build_patch.py --state run/state.json --source project.xlsx \
        --out /mnt/user-data/outputs/batch-decompose-patch.xlsx
"""

import argparse
import json
import sys

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

GREEN = PatternFill("solid", fgColor="C6EFCE")
YELLOW = PatternFill("solid", fgColor="FFEB9C")
HEAD = Font(bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")
TOP = Alignment(vertical="top")

FORK_COLS = ["ID", "Дата", "Уровень", "Развилка", "Контекст", "Варианты", "Принято",
             "Обоснование", "Последствия", "Что отвергнуто и почему", "Основание",
             "Статус", "Статус строки"]
TASK_COLS = ["ID", "Фаза", "Приоритет", "Корень", "Рамка поведения", "Рамка устройства",
             "Класс", "Архитектурные границы", "Единица бэклога", "Зависит от", "Статус",
             "Контракт", "Статус строки"]
SUB_COLS = ["ID", "Родитель", "Слой", "Изменение", "Тип", "Критерий готовности",
            "Зависит от", "Контракт", "Статус строки"]

WIDTHS = {
    "Развилки": {"ID": 10, "Дата": 12, "Уровень": 14, "Развилка": 60, "Контекст": 70,
                 "Варианты": 60, "Принято": 60, "Обоснование": 70, "Последствия": 60,
                 "Что отвергнуто и почему": 60, "Основание": 28, "Статус": 22,
                 "Статус строки": 14},
    "Задачи": {"ID": 14, "Фаза": 10, "Приоритет": 11, "Корень": 16,
               "Рамка поведения": 22, "Рамка устройства": 22, "Класс": 16,
               "Архитектурные границы": 40, "Единица бэклога": 80, "Зависит от": 22,
               "Статус": 18, "Контракт": 16, "Статус строки": 14},
    "Подзадачи": {"ID": 14, "Родитель": 14, "Слой": 16, "Изменение": 70, "Тип": 16,
                  "Критерий готовности": 70, "Зависит от": 22, "Контракт": 16,
                  "Статус строки": 14},
}
WRAPPED = {"Развилка", "Контекст", "Варианты", "Принято", "Обоснование", "Последствия",
           "Что отвергнуто и почему", "Архитектурные границы", "Единица бэклога",
           "Изменение", "Критерий готовности"}


def write_sheet(wb, title, cols, rows, fill):
    ws = wb.create_sheet(title)
    for i, name in enumerate(cols, 1):
        c = ws.cell(1, i, name)
        c.font = HEAD
        ws.column_dimensions[get_column_letter(i)].width = WIDTHS[title][name]
    for r, row in enumerate(rows, 2):
        for i, name in enumerate(cols, 1):
            c = ws.cell(r, i, row.get(name))
            c.fill = fill
            c.alignment = WRAP if name in WRAPPED else TOP
    ws.freeze_panes = "A2"
    return ws


def sub_sort_key(sid):
    head, _, tail = str(sid).rpartition(".")
    try:
        return (head, int(tail))
    except ValueError:
        return (str(sid), 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--source", required=True, help="файл проекта, откуда берутся строки «Задачи»")
    ap.add_argument("--out", required=True)
    ap.add_argument("--new-status", default="ToDo")
    a = ap.parse_args()

    state = json.load(open(a.state, encoding="utf-8"))
    src = openpyxl.load_workbook(a.source, data_only=True)["Задачи"]

    hdr = next(r for r in range(1, 9) if str(src.cell(r, 1).value).strip() == "ID")
    scols = {str(src.cell(hdr, c).value).strip(): c for c in range(1, src.max_column + 1)
             if src.cell(hdr, c).value}
    missing = [n for n in TASK_COLS if n != "Статус строки" and n not in scols]
    if missing:
        # строка «Задачи» помечается «изменено» и применяется целиком:
        # недостающая колонка ушла бы в патч пустой и затёрла бы значение.
        print(f"ОШИБКА: на листе «Задачи» нет колонок: {', '.join(missing)}", file=sys.stderr)
        return 2

    src_rows = {}
    for r in range(hdr + 1, src.max_row + 1):
        v = src.cell(r, scols["ID"]).value
        if v:
            src_rows[str(v).strip()] = r

    decomposed = [t for t, v in state["tasks"].items() if v.get("status") == "decomposed"]
    order = {t: i for i, t in enumerate(state.get("order", sorted(decomposed)))}
    decomposed.sort(key=lambda t: order.get(t, 10**6))

    task_rows, sub_rows = [], []
    for tid in decomposed:
        r = src_rows.get(tid)
        if r is None:
            print(f"ПРОПУСК: задачи {tid} нет в исходном файле", file=sys.stderr)
            continue
        row = {name: src.cell(r, c).value for name, c in scols.items() if name in TASK_COLS}
        row["Статус"] = a.new_status
        row["Статус строки"] = "изменено"
        task_rows.append(row)

        for s in sorted(state["tasks"][tid].get("subtasks", []),
                        key=lambda s: sub_sort_key(s["id"])):
            sub_rows.append({
                "ID": s["id"],
                "Родитель": s.get("parent", tid),
                "Слой": s["layer"],
                "Изменение": s["change"],
                "Тип": s["type"],
                "Критерий готовности": s["criterion"],
                "Зависит от": s.get("depends_on") or "—",
                "Контракт": s.get("contract") or "—",
                "Статус строки": "добавлено",
            })

    fork_rows = [{
        "ID": f.get("id"),
        "Дата": f["date"],
        "Уровень": f.get("level"),
        "Развилка": f["fork"],
        "Контекст": f.get("context"),
        "Варианты": f.get("options"),
        "Принято": f["accepted"],
        "Обоснование": f["rationale"],
        "Последствия": f.get("consequences"),
        "Что отвергнуто и почему": f.get("rejected"),
        "Основание": f.get("source"),
        "Статус": f.get("state", "принято моделью"),
        "Статус строки": "добавлено",
    } for f in state.get("forks", [])]

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    write_sheet(wb, "Развилки", FORK_COLS, fork_rows, GREEN)
    write_sheet(wb, "Задачи", TASK_COLS, task_rows, YELLOW)
    write_sheet(wb, "Подзадачи", SUB_COLS, sub_rows, GREEN)
    wb.save(a.out)

    parked = [t for t, v in state["tasks"].items() if v.get("status") == "parked"]
    print(f"Патч: {a.out}")
    print(f"  Развилки: {len(fork_rows)}   Задачи: {len(task_rows)}   Подзадачи: {len(sub_rows)}")
    if parked:
        print(f"  В патч не вошли (припаркованы): {', '.join(sorted(parked))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
