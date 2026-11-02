#!/usr/bin/env python3
"""Сверка локальной копии файла проекта с выгрузкой из Google Drive.

Байтовое сравнение непригодно: экспорт Google Sheets в xlsx не байт-стабилен
между вызовами (метки времени в zip, порядок частей). Сравнивается
нормализованный дамп ячеек всех листов.

Usage:
    python scripts/check_sync.py --local <path.xlsx> --drive <path.xlsx>
    python scripts/check_sync.py --local <path.xlsx> --drive <path.xlsx> --json

Exit codes:
    0 — копии совпадают, работу можно начинать
    1 — копии расходятся, работу начинать нельзя
    2 — ошибка чтения
"""

import argparse
import datetime as dt
import hashlib
import json
import sys

import openpyxl


def norm_value(v):
    if v is None:
        return None
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, str):
        s = v.replace("\r\n", "\n").strip()
        return s or None
    return str(v)


def dump(path, only=None):
    """{(sheet, row, col): value} по всем непустым ячейкам."""
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    cells = {}
    names = [n for n in wb.sheetnames if only is None or n in only]
    try:
        for name in names:
            ws = wb[name]
            for row in ws.iter_rows():
                for c in row:
                    nv = norm_value(c.value)
                    if nv is not None:
                        cells[(name, c.row, c.column)] = nv
    finally:
        wb.close()
    return names, cells


def digest(sheetnames, cells):
    h = hashlib.sha256()
    h.update("\x1f".join(sheetnames).encode())
    for key in sorted(cells):
        h.update(f"\x1e{key[0]}\x1f{key[1]}\x1f{key[2]}\x1f{cells[key]}".encode())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", required=True, help="копия в папке проекта Cowork")
    ap.add_argument("--drive", required=True, help="свежая выгрузка из Google Drive")
    ap.add_argument("--sheets", help="сверять только эти листы, через запятую")
    ap.add_argument("--max-diff", type=int, default=25, help="сколько расхождений печатать")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    only = {s.strip() for s in a.sheets.split(",")} if a.sheets else None
    try:
        l_sheets, l_cells = dump(a.local, only)
        d_sheets, d_cells = dump(a.drive, only)
    except Exception as e:  # noqa: BLE001
        print(f"ОШИБКА ЧТЕНИЯ: {e}", file=sys.stderr)
        return 2

    l_dig, d_dig = digest(l_sheets, l_cells), digest(d_sheets, d_cells)
    equal = l_dig == d_dig

    diffs = []
    if not equal:
        if l_sheets != d_sheets:
            diffs.append({
                "kind": "sheets",
                "local_only": [s for s in l_sheets if s not in d_sheets],
                "drive_only": [s for s in d_sheets if s not in l_sheets],
            })
        for key in sorted(set(l_cells) | set(d_cells)):
            lv, dv = l_cells.get(key), d_cells.get(key)
            if lv != dv:
                diffs.append({
                    "kind": "cell",
                    "sheet": key[0],
                    "cell": f"{openpyxl.utils.get_column_letter(key[2])}{key[1]}",
                    "local": (lv or "")[:80],
                    "drive": (dv or "")[:80],
                })

    result = {
        "equal": equal,
        "local_digest": l_dig,
        "drive_digest": d_dig,
        "diff_count": len([d for d in diffs if d["kind"] == "cell"]),
        "diffs": diffs[: a.max_diff],
    }

    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif equal:
        print(f"СОВПАДАЮТ  sha256={l_dig[:16]}  ячеек={len(l_cells)}")
    else:
        print(f"РАСХОЖДЕНИЕ  локально={l_dig[:16]}  drive={d_dig[:16]}")
        print(f"Расхождений в ячейках: {result['diff_count']}")
        for d in result["diffs"]:
            if d["kind"] == "sheets":
                print(f"  листы: только локально {d['local_only']}, только в Drive {d['drive_only']}")
            else:
                print(f"  {d['sheet']}!{d['cell']}: локально «{d['local']}» / drive «{d['drive']}»")
        if result["diff_count"] > a.max_diff:
            print(f"  ... и ещё {result['diff_count'] - a.max_diff}")

    return 0 if equal else 1


if __name__ == "__main__":
    sys.exit(main())
