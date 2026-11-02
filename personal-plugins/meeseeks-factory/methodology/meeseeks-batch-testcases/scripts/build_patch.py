#!/usr/bin/env python3
"""Сборка сводного xlsx-патча прогона из run/state.json.

Листы: «Решения» (короткие фиксации), «Развилки» (развилки прогона с вариантами
и отвергнутым), «Задачи» (изменённая колонка «Статус», выпускается только при
заданном --new-status), «Тесткейсы» (добавленные — зелёные, изменённые — жёлтые).

Развилка с вариантами на лист «Решения» не кладётся: у неё двенадцать колонок
листа «Развилки». Статус развилки, закрытой оркестратором, — «принято моделью».

Usage:
    python scripts/build_patch.py --state run/state.json --source project.xlsx \
        --out /mnt/user-data/outputs/batch-testcases-patch.xlsx [--new-status NeedSpec]
"""

import argparse
import json
import re
import sys

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

GREEN = PatternFill("solid", fgColor="C6EFCE")
YELLOW = PatternFill("solid", fgColor="FFEB9C")
HEAD = Font(bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")
TOP = Alignment(vertical="top")

DEC_COLS = ["Дата", "Решение", "Обоснование", "Статус", "Статус строки"]
FORK_COLS = ["ID", "Дата", "Уровень", "Развилка", "Контекст", "Варианты", "Принято",
             "Обоснование", "Последствия", "Что отвергнуто и почему", "Основание",
             "Статус", "Статус строки"]
TASK_COLS = ["ID", "Фаза", "Приоритет", "Корень", "Рамка поведения", "Рамка устройства",
             "Класс", "Архитектурные границы", "Единица бэклога", "Зависит от",
             "Статус", "Контракт", "Статус строки"]
TC_COLS = ["TC-ID", "Уровень", "Тип", "Единица бэклога", "Источник",
           "Given", "When", "Then", "Контракт", "Статус строки"]

WIDTHS = {
    "Решения": {"Дата": 12, "Решение": 80, "Обоснование": 70, "Статус": 12,
                "Статус строки": 14},
    "Развилки": {"ID": 10, "Дата": 12, "Уровень": 12, "Развилка": 60, "Контекст": 60,
                 "Варианты": 60, "Принято": 50, "Обоснование": 60, "Последствия": 50,
                 "Что отвергнуто и почему": 60, "Основание": 26, "Статус": 18,
                 "Статус строки": 14},
    "Задачи": {"ID": 14, "Фаза": 10, "Приоритет": 11, "Корень": 12,
               "Рамка поведения": 16, "Рамка устройства": 16, "Класс": 14,
               "Архитектурные границы": 40, "Единица бэклога": 80, "Зависит от": 22,
               "Статус": 18, "Контракт": 12, "Статус строки": 14},
    "Тесткейсы": {"TC-ID": 18, "Уровень": 16, "Тип": 8, "Единица бэклога": 16,
                  "Источник": 18, "Given": 55, "When": 45, "Then": 60, "Контракт": 12,
                  "Статус строки": 14},
}
WRAPPED = {"Решение", "Обоснование", "Единица бэклога", "Given", "When", "Then",
           "Архитектурные границы", "Развилка", "Контекст", "Варианты", "Принято",
           "Последствия", "Что отвергнуто и почему"}
DASH = "—"


def write_sheet(wb, title, cols, rows):
    ws = wb.create_sheet(title)
    for i, name in enumerate(cols, 1):
        c = ws.cell(1, i, name)
        c.font = HEAD
        ws.column_dimensions[get_column_letter(i)].width = WIDTHS[title][name]
    for r, row in enumerate(rows, 2):
        fill = YELLOW if row.get("Статус строки") == "изменено" else GREEN
        for i, name in enumerate(cols, 1):
            c = ws.cell(r, i, row.get(name))
            c.fill = fill
            c.alignment = WRAP if name in WRAPPED else TOP
    ws.freeze_panes = "A2"
    return ws


def joined(v):
    """Список кладётся в ячейку по строке на элемент."""
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return "\n".join(str(x) for x in v)
    return str(v)


def next_fork_id(wb):
    """Следующий свободный Р-N по листу «Развилки» исходного файла."""
    if "Развилки" not in wb.sheetnames:
        return 1
    ws = wb["Развилки"]
    hdr = next((r for r in range(1, 9)
                if str(ws.cell(r, 1).value).strip() == "ID"), None)
    if hdr is None:
        return 1
    mx = 0
    for r in range(hdr + 1, ws.max_row + 1):
        m = re.fullmatch(r"Р-(\d+)", str(ws.cell(r, 1).value or "").strip())
        if m:
            mx = max(mx, int(m.group(1)))
    return mx + 1


def tc_sort_key(tc):
    """Порядок: по единице бэклога, внутри — по источнику и TC-ID."""
    return (str(tc.get("backlog_unit") or ""), str(tc.get("source") or ""),
            str(tc.get("tc_id") or ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--source", required=True, help="файл проекта, откуда берутся строки «Задачи»")
    ap.add_argument("--out", required=True)
    ap.add_argument("--new-status", help="литерал статуса задачи после покрытия кейсами; "
                                         "без него лист «Задачи» не выпускается")
    a = ap.parse_args()

    state = json.load(open(a.state, encoding="utf-8"))
    src_wb = openpyxl.load_workbook(a.source, data_only=True)
    src = src_wb["Задачи"]

    hdr = next(r for r in range(1, 9) if str(src.cell(r, 1).value).strip() == "ID")
    scols = {str(src.cell(hdr, c).value).strip(): c for c in range(1, src.max_column + 1)
             if src.cell(hdr, c).value}
    src_rows = {}
    for r in range(hdr + 1, src.max_row + 1):
        v = src.cell(r, scols["ID"]).value
        if v:
            src_rows[str(v).strip()] = r

    covered = [t for t, v in state["tasks"].items() if v.get("status") == "covered"]
    order = {t: i for i, t in enumerate(state.get("order", sorted(covered)))}
    covered.sort(key=lambda t: order.get(t, 10 ** 6))

    task_rows = []
    if a.new_status:
        for tid in covered:
            r = src_rows.get(tid)
            if r is None:
                print(f"ПРОПУСК: задачи {tid} нет в исходном файле", file=sys.stderr)
                continue
            row = {name: src.cell(r, c).value for name, c in scols.items() if name in TASK_COLS}
            row["Статус"] = a.new_status
            row["Статус строки"] = "изменено"
            task_rows.append(row)

    tc_rows = []
    for tc in sorted(state.get("testcases", []), key=tc_sort_key):
        if tc.get("task") and tc["task"] not in covered:
            continue  # кейсы припаркованной задачи в патч не идут
        tc_rows.append({
            "TC-ID": tc["tc_id"],
            "Уровень": tc["level"],
            "Тип": tc["type"],
            "Единица бэклога": tc["backlog_unit"],
            "Источник": tc["source"],
            "Given": tc["given"],
            "When": tc["when"],
            "Then": tc["then"],
            "Контракт": tc.get("contract") or DASH,
            "Статус строки": tc.get("row_status", "добавлено"),
        })

    # Короткая фиксация идёт на «Решения»; развилка с вариантами и отвергнутым —
    # на «Развилки», двенадцать колонок листа.
    dec_rows, fork_rows = [], []
    fork_no = next_fork_id(src_wb)
    for d in state.get("decisions", []):
        if not (d.get("fork") or d.get("options") or d.get("rejected")):
            dec_rows.append({
                "Дата": d["date"],
                "Решение": d["decision"],
                "Обоснование": d["rationale"],
                "Статус": d.get("state", "принято"),
                "Статус строки": "добавлено",
            })
            continue
        fid = d.get("id")
        if not fid:
            fid, fork_no = f"Р-{fork_no}", fork_no + 1
        fork_rows.append({
            "ID": fid,
            "Дата": d["date"],
            "Уровень": d.get("level", "задача"),
            "Развилка": joined(d.get("fork") or d.get("decision")),
            "Контекст": joined(d.get("context")),
            "Варианты": joined(d.get("options")),
            "Принято": joined(d.get("accepted") or d.get("decision")),
            "Обоснование": joined(d.get("rationale")),
            "Последствия": joined(d.get("consequences")),
            "Что отвергнуто и почему": joined(d.get("rejected")),
            "Основание": joined(d.get("basis")),
            "Статус": d.get("state", "принято моделью"),
            "Статус строки": "добавлено",
        })

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    write_sheet(wb, "Решения", DEC_COLS, dec_rows)
    write_sheet(wb, "Развилки", FORK_COLS, fork_rows)
    if a.new_status:
        write_sheet(wb, "Задачи", TASK_COLS, task_rows)
    write_sheet(wb, "Тесткейсы", TC_COLS, tc_rows)
    wb.save(a.out)

    parked = [t for t, v in state["tasks"].items() if v.get("status") == "parked"]
    added = sum(1 for r in tc_rows if r["Статус строки"] == "добавлено")
    changed = len(tc_rows) - added
    print(f"Патч: {a.out}")
    print(f"  Решения: {len(dec_rows)}   Развилки: {len(fork_rows)}   "
          f"Задачи: {len(task_rows)}   Тесткейсы: +{added} / изм. {changed}")
    if not a.new_status:
        print("  Лист «Задачи» не выпущен: --new-status не задан")
    if parked:
        print(f"  В патч не вошли (припаркованы): {', '.join(sorted(parked))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
