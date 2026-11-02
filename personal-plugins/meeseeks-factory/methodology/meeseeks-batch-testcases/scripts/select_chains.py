#!/usr/bin/env python3
"""Выборка задач по статусу и группировка их в цепочки по рамке поведения.

Единица диспатча — цепочка одной рамки поведения, а не задача: meeseeks-testcases
работает по цепочке рамка→задачи→подзадачи, ведёт аудит покрытия всей цепочки и
выпускает один приёмочный E-кейс на стори. Две задачи одной рамки поведения,
отданные разным сабагентам, дали бы два аудита одной цепочки и два приёмочных
кейса.

В цепочку входят все задачи рамки, включая те, что в выборку по статусу не
попали: они дают контекст покрытия и определяют замыкающую задачу. В патч
статуса войдут только выбранные.

Задача с пустой «Рамкой поведения» — техническая: цепочки у неё нет, идёт в
одиночку, приёмочного кейса стори у неё не бывает. Это норма, не деградация.

Usage:
    python scripts/select_chains.py <project.xlsx> [--status ToDo]
        [--parallel 3] [--out run/plan.json]
"""

import argparse
import json
import sys
from collections import Counter

import openpyxl

DEFAULT_STATUS = "ToDo"  # литерал файла проекта: декомпозированная задача
EMPTY = {"—", "-", "–", "", "None", "нет", "none"}


def find_header(ws, first_col_value="ID", limit=8):
    for r in range(1, min(limit, ws.max_row) + 1):
        if str(ws.cell(r, 1).value).strip() == first_col_value:
            return r
    raise SystemExit(f"Не найдена строка заголовка на листе «{ws.title}»")


def cols_of(ws, hdr):
    return {str(ws.cell(hdr, c).value).strip(): c
            for c in range(1, ws.max_column + 1) if ws.cell(hdr, c).value}


def norm(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if s in EMPTY else s


def parse_deps(raw):
    if raw is None:
        return []
    out = []
    for part in str(raw).replace(";", ",").split(","):
        p = part.strip()
        if p and p not in EMPTY:
            out.append(p)
    return out


def order_chain(ids, deps):
    """Топологический порядок внутри цепочки; рёбра — только внутри неё."""
    done, order, remaining = set(), [], {i: [d for d in deps.get(i, []) if d in ids] for i in ids}
    while remaining:
        ready = sorted(n for n, d in remaining.items() if all(x in done for x in d))
        if not ready:
            order.extend(sorted(remaining))
            return order, True
        order.extend(ready)
        done.update(ready)
        for n in ready:
            remaining.pop(n)
    return order, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--status", default=DEFAULT_STATUS)
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--out")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    tasks_ws = wb["Задачи"]
    t_hdr = find_header(tasks_ws)
    tc = cols_of(tasks_ws, t_hdr)
    for need in ("ID", "Рамка поведения", "Единица бэклога", "Зависит от", "Статус"):
        if need not in tc:
            raise SystemExit(f"На листе «Задачи» нет колонки «{need}»")

    # подзадачи: шапка в третьей строке, колонки читаются по имени, не по индексу
    sub_ws = wb["Подзадачи"]
    s_hdr = find_header(sub_ws)
    sc = cols_of(sub_ws, s_hdr)
    if "Родитель" not in sc:
        raise SystemExit("На листе «Подзадачи» нет колонки «Родитель»")
    sub_count = Counter()
    for r in range(s_hdr + 1, sub_ws.max_row + 1):
        p = norm(sub_ws.cell(r, sc["Родитель"]).value)
        if p:
            sub_count[p] += 1

    # существующие кейсы по единице бэклога
    tcase_count = Counter()
    if "Тесткейсы" in wb.sheetnames:
        tcw = wb["Тесткейсы"]
        tch = find_header(tcw, "TC-ID")
        tcc = cols_of(tcw, tch)
        unit_col = tcc.get("Единица бэклога")
        if unit_col:
            for r in range(tch + 1, tcw.max_row + 1):
                u = norm(tcw.cell(r, unit_col).value)
                if u:
                    tcase_count[u] += 1

    tasks, status_values = {}, Counter()
    for r in range(t_hdr + 1, tasks_ws.max_row + 1):
        tid = norm(tasks_ws.cell(r, tc["ID"]).value)
        if not tid:
            continue
        st = norm(tasks_ws.cell(r, tc["Статус"]).value)
        status_values[st or "—"] += 1
        tasks[tid] = {
            "id": tid,
            "row": r,
            "status": st,
            "story": norm(tasks_ws.cell(r, tc["Рамка поведения"]).value),
            "backlog_unit": norm(tasks_ws.cell(r, tc["Единица бэклога"]).value),
            "depends_on": parse_deps(tasks_ws.cell(r, tc["Зависит от"]).value),
            "subtask_count": sub_count.get(tid, 0),
            "testcase_count": tcase_count.get(tid, 0),
        }

    selected = [t for t in tasks.values() if t["status"] == a.status]
    if not selected:
        print("Значения колонки «Статус» в файле: "
              + ", ".join(f"«{k}» × {v}" for k, v in status_values.most_common()),
              file=sys.stderr)
        raise SystemExit(f"Задач со статусом «{a.status}» не найдено")

    deps = {t: v["depends_on"] for t, v in tasks.items()}
    by_story, solo = {}, []
    for t in selected:
        if t["story"]:
            by_story.setdefault(t["story"], []).append(t)
        else:
            solo.append(t)

    groups = []
    for story, sel in sorted(by_story.items(), key=lambda kv: min(t["row"] for t in kv[1])):
        chain_ids = sorted(t["id"] for t in tasks.values() if t["story"] == story)
        order, cycle = order_chain(set(chain_ids), deps)
        dependents = {i: 0 for i in chain_ids}
        for i in chain_ids:
            for d in deps.get(i, []):
                if d in dependents:
                    dependents[d] += 1
        closing = [i for i in chain_ids if dependents[i] == 0]
        groups.append({
            "id": f"story-{story}",
            "story": story,
            "technical": False,
            "degraded": False,
            "cycle": cycle,
            "tasks_selected": sorted(t["id"] for t in sel),
            "chain_order": order,
            "closing_candidates": sorted(closing),
            "closing": closing[0] if len(closing) == 1 else None,
            "chain": [{k: tasks[i][k] for k in
                       ("id", "status", "backlog_unit", "depends_on",
                        "subtask_count", "testcase_count")} for i in order],
            "warnings": [],
        })

    for t in sorted(solo, key=lambda x: x["row"]):
        groups.append({
            "id": f"tech-{t['id']}",
            "story": None,
            "technical": True,
            "degraded": False,
            "cycle": False,
            "tasks_selected": [t["id"]],
            "chain_order": [t["id"]],
            "closing_candidates": [t["id"]],
            "closing": t["id"],
            "chain": [{k: t[k] for k in ("id", "status", "backlog_unit", "depends_on",
                                         "subtask_count", "testcase_count")}],
            "note": "рамка поведения пуста: задача техническая, цепочки нет, "
                    "приёмочный кейс стори не выпускается — это норма",
            "warnings": [],
        })

    for g in groups:
        for t in g["chain"]:
            if t["status"] == a.status and t["subtask_count"] == 0:
                g["warnings"].append(f"{t['id']}: статус «{a.status}», подзадач нет")
        if len(g["closing_candidates"]) > 1:
            g["warnings"].append("замыкающая задача цепочки не определяется однозначно: "
                                 + ", ".join(g["closing_candidates"]))
        if g["cycle"]:
            g["warnings"].append("цикл в «Зависит от» внутри цепочки")

    waves = [[g["id"] for g in groups[i:i + a.parallel]]
             for i in range(0, len(groups), a.parallel)]

    plan = {
        "status_literal": a.status,
        "source": a.xlsx,
        "selected_count": len(selected),
        "group_count": len(groups),
        "status_values": dict(status_values.most_common()),
        "waves": waves,
        "groups": groups,
    }

    text = json.dumps(plan, ensure_ascii=False, indent=2, default=str)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        for i, wave in enumerate(waves):
            print(f"Волна {i}: {', '.join(wave)}")
        print()
        for g in groups:
            mark = " (техническая)" if g["technical"] else ""
            print(f"{g['id']}{mark}: выбрано {', '.join(g['tasks_selected'])} "
                  f"| цепочка {', '.join(g['chain_order'])} "
                  f"| замыкающая {g['closing'] or '?'}")
            for w in g["warnings"]:
                print(f"    ! {w}")
        print(f"\nЗадач: {len(selected)}, цепочек: {len(groups)}. План: {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
