#!/usr/bin/env python3
"""Выборка задач по статусу и раскладка их на слои DAG по «Зависит от».

Рёбра берутся только внутри выборки: зависимость на задачу вне выборки
означает, что она уже декомпозирована либо не в скоупе прогона, и на порядок
обхода не влияет.

Usage:
    python scripts/select_tasks.py <project.xlsx> [--status "Не декоспозирована"] [--out run/plan.json]
"""

import argparse
import json
import sys

import openpyxl

DEFAULT_STATUS = "Не декоспозирована"  # литерал файла проекта, с опечаткой
EMPTY_DEP = {"—", "-", "–", "", "None", "нет"}


def find_header(ws, first_col_value="ID", limit=8):
    for r in range(1, min(limit, ws.max_row) + 1):
        if str(ws.cell(r, 1).value).strip() == first_col_value:
            return r
    raise SystemExit(f"Не найдена строка заголовка на листе «{ws.title}»")


def parse_deps(raw):
    if raw is None:
        return []
    out = []
    for part in str(raw).replace(";", ",").split(","):
        p = part.strip()
        if p and p not in EMPTY_DEP:
            out.append(p)
    return out


def layers(nodes, edges):
    """edges: {node: [deps]} — раскладка на слои, зависимость раньше зависящего."""
    done, result, remaining = set(), [], dict(edges)
    while remaining:
        layer = sorted(n for n, d in remaining.items() if all(x in done for x in d))
        if not layer:
            # цикл: остаток одним слоем, помечается вызывающим
            result.append({"cycle": True, "tasks": sorted(remaining)})
            break
        result.append({"cycle": False, "tasks": layer})
        done.update(layer)
        for n in layer:
            remaining.pop(n)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--status", default=DEFAULT_STATUS)
    ap.add_argument("--out")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    tasks_ws, sub_ws = wb["Задачи"], wb["Подзадачи"]

    t_hdr = find_header(tasks_ws)
    cols = {str(tasks_ws.cell(t_hdr, c).value).strip(): c
            for c in range(1, tasks_ws.max_column + 1)
            if tasks_ws.cell(t_hdr, c).value}
    for need in ("ID", "Единица бэклога", "Зависит от", "Статус"):
        if need not in cols:
            raise SystemExit(f"На листе «Задачи» нет колонки «{need}»")

    s_hdr = find_header(sub_ws)
    parents = set()
    for r in range(s_hdr + 1, sub_ws.max_row + 1):
        p = sub_ws.cell(r, 2).value
        if p:
            parents.add(str(p).strip())

    selected = {}
    for r in range(t_hdr + 1, tasks_ws.max_row + 1):
        tid = tasks_ws.cell(r, cols["ID"]).value
        if not tid:
            continue
        if str(tasks_ws.cell(r, cols["Статус"]).value).strip() != a.status:
            continue
        tid = str(tid).strip()
        selected[tid] = {
            "id": tid,
            "row": r,
            "phase": tasks_ws.cell(r, cols["Фаза"]).value if "Фаза" in cols else None,
            "priority": tasks_ws.cell(r, cols["Приоритет"]).value if "Приоритет" in cols else None,
            "backlog_unit": tasks_ws.cell(r, cols["Единица бэклога"]).value,
            "depends_on_raw": tasks_ws.cell(r, cols["Зависит от"]).value,
            "depends_on": parse_deps(tasks_ws.cell(r, cols["Зависит от"]).value),
            "has_subtasks": tid in parents,
        }

    if not selected:
        raise SystemExit(f"Задач со статусом «{a.status}» не найдено")

    edges = {t: [d for d in v["depends_on"] if d in selected] for t, v in selected.items()}
    plan = {
        "status_literal": a.status,
        "source": a.xlsx,
        "task_count": len(selected),
        "layers": layers(set(selected), edges),
        "tasks": selected,
    }

    text = json.dumps(plan, ensure_ascii=False, indent=2, default=str)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        for i, layer in enumerate(plan["layers"]):
            mark = " ЦИКЛ" if layer["cycle"] else ""
            print(f"Слой {i}{mark}: {', '.join(layer['tasks'])}")
        print(f"\nВсего задач: {len(selected)}. План: {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
