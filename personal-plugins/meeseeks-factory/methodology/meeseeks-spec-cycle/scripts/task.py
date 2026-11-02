#!/usr/bin/env python3
"""Состав срезов задачи по листу «Срезы» файла проекта.

Единица прогона циклового скила - задача. Её срезы лежат на листе «Срезы» и
связаны с задачей колонкой «Родитель». Порядок между срезами выражает план,
очередь сериализует прогоны, поэтому проверять здесь нечего: скрипт собирает
состав и раскладывает зависимости на внутренние (срез той же задачи - ребро
плана) и внешние (срез другой задачи - зона ответственности оператора).

Задача есть в реестре, а срезов у неё нет - это код 0 и `sliced: false`:
нарезка делается `meeseeks-slice`, а не этим скриптом.

Usage:
    python scripts/task.py <project.xlsx> --task IC-10 --out run/ic-10/task.json
    python scripts/task.py <project.xlsx> --slices CI-9-S1,AS-4-S1 --out task.json

Exit codes:
    0 — состав собран
    2 — задачи или среза с таким ID нет; лист не разобран
"""

import argparse
import json
import re
import sys
from pathlib import Path

import openpyxl

DONE = "done"
EMPTY = {"—", "-", "–", "", "none", "нет", "n/a"}
SPLIT = re.compile(r"[,;\n]+")
YES = {"да", "yes", "true", "1", "+", "замыкающий"}


def norm(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if s.lower() in EMPTY else s


def find_header(ws, must_have, limit=10):
    """Строка заголовка — первая, где присутствуют все названия из must_have."""
    want = {m.lower() for m in must_have}
    for r in range(1, min(limit, ws.max_row) + 1):
        have = {str(ws.cell(r, c).value).strip().lower()
                for c in range(1, ws.max_column + 1) if ws.cell(r, c).value}
        if want <= have:
            return r
    raise SystemExit(
        f"На листе «{ws.title}» не найдена строка заголовка "
        f"с колонками: {', '.join(must_have)}"
    )


def cols_of(ws, hdr):
    return {str(ws.cell(hdr, c).value).strip(): c
            for c in range(1, ws.max_column + 1) if ws.cell(hdr, c).value}


def pick(cols, *names, contains=None):
    for n in names:
        if n in cols:
            return cols[n]
    if contains:
        for title, c in cols.items():
            if contains.lower() in title.lower():
                return c
    return None


def split_ids(raw):
    if raw is None:
        return []
    return [p.strip() for p in SPLIT.split(str(raw)) if p.strip()
            and p.strip().lower() not in EMPTY]


def read_slices(wb):
    """{ID среза: строка среза} в порядке листа."""
    ws = wb["Срезы"]
    hdr = find_header(ws, ["ID"])
    cols = cols_of(ws, hdr)
    c_id = cols["ID"]
    c_parent = pick(cols, "Родитель", contains="родител")
    c_repo = pick(cols, "Репозиторий", contains="репозитор")
    c_result = pick(cols, "Результат", contains="результат")
    c_criterion = pick(cols, "Критерий готовности", contains="критерий")
    c_deps = pick(cols, "Зависит от", contains="зависит")
    c_status = pick(cols, "Статус", contains="статус")
    c_closing = pick(cols, "Замыкающий", contains="замыка")
    c_contract = pick(cols, "Контракт", contains="контракт")

    rows = {}
    for r in range(hdr + 1, ws.max_row + 1):
        sid = norm(ws.cell(r, c_id).value)
        if not sid:
            continue
        rows[sid] = {
            "id": sid,
            "row": r,
            "task": norm(ws.cell(r, c_parent).value) if c_parent else None,
            "repo": norm(ws.cell(r, c_repo).value) if c_repo else None,
            "result": norm(ws.cell(r, c_result).value) if c_result else None,
            "criterion": norm(ws.cell(r, c_criterion).value) if c_criterion else None,
            "depends_on": split_ids(ws.cell(r, c_deps).value) if c_deps else [],
            "status": norm(ws.cell(r, c_status).value) if c_status else None,
            "closing": (str(norm(ws.cell(r, c_closing).value) or "").lower() in YES)
            if c_closing else None,
            "contracts": split_ids(ws.cell(r, c_contract).value) if c_contract else [],
        }
    return rows


def read_tasks(wb):
    """{ID задачи: {...}} либо None, если листа «Задачи» нет."""
    if "Задачи" not in wb.sheetnames:
        return None
    ws = wb["Задачи"]
    hdr = find_header(ws, ["ID"])
    cols = cols_of(ws, hdr)
    c_id = cols["ID"]
    c_unit = pick(cols, "Единица бэклога", contains="единица")
    c_status = pick(cols, "Статус", contains="статус")
    c_root = pick(cols, "Корень", contains="корень")
    c_behavior = pick(cols, "Рамка поведения", contains="рамка повед")
    c_design = pick(cols, "Рамка устройства", contains="рамка устрой")
    c_class = pick(cols, "Класс", contains="класс")
    c_contract = pick(cols, "Контракт", contains="контракт")

    tasks = {}
    for r in range(hdr + 1, ws.max_row + 1):
        tid = norm(ws.cell(r, c_id).value)
        if not tid:
            continue
        tasks[tid] = {
            "id": tid,
            "row": r,
            "title": norm(ws.cell(r, c_unit).value) if c_unit else None,
            "status": norm(ws.cell(r, c_status).value) if c_status else None,
            "root": norm(ws.cell(r, c_root).value) if c_root else None,
            "behavior_frame": norm(ws.cell(r, c_behavior).value) if c_behavior else None,
            "design_frame": norm(ws.cell(r, c_design).value) if c_design else None,
            "class": norm(ws.cell(r, c_class).value) if c_class else None,
            "contracts": split_ids(ws.cell(r, c_contract).value) if c_contract else [],
        }
    return tasks


def resolve_deps(composition, slices):
    """Зависимости среза: внутри задачи — ребро плана, снаружи — на операторе."""
    inside = set(composition)
    for sid in composition:
        row = slices.get(sid)
        if not row:
            continue
        row["depends_in_task"] = [d for d in row["depends_on"] if d in inside]
        row["depends_external"] = [
            {
                "id": d,
                "found": d in slices,
                "status": slices[d]["status"] if d in slices else None,
                "done": (slices[d]["status"] or "").strip().lower() == DONE
                if d in slices else False,
            }
            for d in row["depends_on"] if d not in inside
        ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--task", help="ID задачи, например IC-10")
    ap.add_argument("--slices", help="перечень ID срезов через запятую вместо ID задачи")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    if "Срезы" not in wb.sheetnames:
        print("В файле проекта нет листа «Срезы»", file=sys.stderr)
        return 2
    slices = read_slices(wb)
    tasks = read_tasks(wb)

    if bool(a.task) == bool(a.slices):
        print("Задаётся ровно одно: --task или --slices", file=sys.stderr)
        return 2

    if a.task:
        task_id = a.task
        composition = [s for s in slices if slices[s]["task"] == task_id]
        known = tasks is not None and task_id in tasks
        if not composition and not known:
            print(
                f"Задачи «{task_id}» нет: срезов с таким родителем на листе «Срезы» "
                f"нет и на листе «Задачи» её нет.\n"
                "Похожий ID не подбирается — спросить человека.",
                file=sys.stderr,
            )
            return 2
        unit = tasks[task_id]["title"] if known else None
        task_status = tasks[task_id]["status"] if known else None
        task_row = tasks[task_id] if known else None
    else:
        task_id = None
        unit = None
        task_status = None
        task_row = None
        composition = split_ids(a.slices)
        missing = [s for s in composition if s not in slices]
        if missing:
            print(
                f"Срезов нет на листе «Срезы»: {', '.join(missing)}\n"
                "Похожий ID не подбирается: CI-9-S1 и CI-9-S10 — разные срезы.",
                file=sys.stderr,
            )
            return 2
        parents = {slices[s]["task"] for s in composition if slices[s]["task"]}
        if len(parents) == 1:
            task_id = parents.pop()
            if tasks and task_id in tasks:
                unit = tasks[task_id]["title"]
                task_status = tasks[task_id]["status"]
                task_row = tasks[task_id]

    resolve_deps(composition, slices)
    rows = [slices[s] for s in composition if s in slices]
    result = {
        "task": task_id,
        "unit": unit,
        "task_status": task_status,
        "task_root": task_row["root"] if task_row else None,
        "task_behavior_frame": task_row["behavior_frame"] if task_row else None,
        "task_design_frame": task_row["design_frame"] if task_row else None,
        "task_class": task_row["class"] if task_row else None,
        "task_contracts": task_row["contracts"] if task_row else [],
        "source": a.xlsx,
        "sliced": bool(composition),
        "composition": composition,
        "slice_count": len(composition),
        "repo_count": len({r["repo"] for r in rows if r["repo"]}),
        "slices": rows,
    }

    text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text, encoding="utf-8")

    if a.json and not a.out:
        print(text)
    else:
        head = task_id or "перечень срезов"
        if not composition:
            print(f"Задача {head}: срезов на листе «Срезы» нет — нарезка не сделана")
        else:
            print(f"Задача {head}: срезов {len(composition)}, "
                  f"репозиториев {result['repo_count']}")
        for row in rows:
            line = (f"  {row['id']} · {row['repo'] or 'репозиторий не указан'} · "
                    f"{row['status'] or 'статус пуст'}")
            if row["closing"]:
                line += " · замыкающий"
            if row["depends_in_task"]:
                line += f" · после {', '.join(row['depends_in_task'])}"
            ext = [d["id"] for d in row["depends_external"] if not d["done"]]
            if ext:
                line += f" · внешние зависимости не в Done: {', '.join(ext)}"
            print(line)
        if a.out:
            print(f"Состав: {a.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
