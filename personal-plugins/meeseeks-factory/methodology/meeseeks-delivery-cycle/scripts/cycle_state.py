#!/usr/bin/env python3
"""Состояние сквозного прогона задачи Mr Meeseeks.

Держит по каждому срезу: репозиторий, базовую ветку, ID контракта, зависимости
внутри задачи, номер цикла доработки, файлы ТЗ каждого цикла, ветку и PR,
терминальное состояние.

Отвечает на один вопрос оркестратора: что диспатчить дальше. Порядок срезов
считается по графу зависимостей, номер цикла - по записанным ТЗ, потолок
доработок - по счётчику среза. Глазом это не считается: ошибка порядка
обнаруживается сгоревшим слотом воркера, ошибка счётчика - перезаписанным ТЗ.

Коды возврата: 0 - выполнено, 2 - вход отвергнут.
"""

import argparse
import json
import sys
from pathlib import Path

MAX_REWORK_DEFAULT = 5

# Состояния среза.
#   pending      - ТЗ есть, реализация не начиналась
#   implementing - часть ТЗ текущего цикла реализована, есть ещё части
#   implemented  - все части текущего цикла реализованы, ждёт приёмки
#   reworking    - вердикт не PASS, ТЗ на доработку ещё не записано
#   passed       - терминально: PASS
#   dropped      - терминально: выпал (развилка, ошибка нарезки, нет ТЗ)
#   exhausted    - терминально: потолок доработок исчерпан
#   failed       - терминально: сабагент не вернул результат
TERMINAL = {"passed", "dropped", "exhausted", "failed"}
UNSUCCESSFUL = TERMINAL - {"passed"}


def die(msg):
    print(f"ОТКАЗ: {msg}", file=sys.stderr)
    sys.exit(2)


def load(path):
    p = Path(path)
    if not p.exists():
        die(f"файла состояния нет: {path}")
    return json.loads(p.read_text(encoding="utf-8"))


def save(path, state):
    Path(path).write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def slice_of(state, slice_id):
    s = state["slices"].get(slice_id)
    if s is None:
        die(f"среза {slice_id} нет в составе прогона")
    return s


# --------------------------------------------------------------------------- init


def cmd_init(args):
    """Собрать состояние из результата сабагента spec-cycle.

    На входе JSON вида:
      {"task": "CI-9", "title": "...",
       "slices": [{"slice_id": "CI-9-S1", "repo": "org/repo",
                   "base_branch": "integration/worker-slot", "contract": "K-4",
                   "env": "mr_meeseeks",
                   "depends_in_task": ["CI-9-S2"], "outcome": "spec",
                   "tz_files": ["...part-01-of-02.tz.md", "..."],
                   "tz_paths": ["run/CI-9/CI-9-S1/tz-part-1.md", "..."]}]}

    Срез с outcome не spec заводится сразу терминальным: ТЗ по нему нет.

    repo и base_branch у среза с outcome=spec обязательны: оба приходят из одной
    колонки «Репозиторий» листа «Срезы». Дефолтная ветка репозитория вместо
    пустой base_branch не подставляется - молчаливый откат на неё строит ветку,
    PR и ревью против чужой базы.
    """
    src = json.loads(Path(args.spec_result).read_text(encoding="utf-8"))
    task = src.get("task") or args.task
    if not task:
        die("ID задачи не назван ни во входе, ни ключом --task")

    slices = {}
    for row in src.get("slices", []):
        sid = row["slice_id"]
        outcome = row.get("outcome", "spec")
        tz_files = list(row.get("tz_files") or [])
        tz_paths = list(row.get("tz_paths") or [])
        if outcome == "spec" and not tz_files:
            die(f"срез {sid} с outcome=spec без файлов ТЗ")
        if outcome == "spec" and not row.get("repo"):
            die(f"срез {sid} с outcome=spec без репозитория")
        if outcome == "spec" and not row.get("base_branch"):
            die(
                f"срез {sid} с outcome=spec без базовой ветки: base_branch "
                "читается из колонки «Репозиторий» листа «Срезы» и не "
                "подставляется дефолтной веткой репозитория"
            )
        if tz_paths and len(tz_paths) != len(tz_files):
            die(f"срез {sid}: tz_paths и tz_files разной длины")
        entry = {
            "repo": row.get("repo"),
            "base_branch": row.get("base_branch"),
            "contract": row.get("contract"),
            "env": row.get("env"),
            "depends_in_task": list(row.get("depends_in_task") or []),
            "cycle": 0,
            "state": "pending" if outcome == "spec" else "dropped",
            "reason": None if outcome == "spec" else f"spec-cycle: {outcome}",
            "branch": None,
            "pr": None,
            "done_parts": 0,
            "tz": [],
            "reviews": [],
        }
        if outcome == "spec":
            entry["tz"].append({"cycle": 0, "files": tz_files, "paths": tz_paths})
        slices[sid] = entry

    if not slices:
        die("в результате spec-cycle нет ни одного среза")

    unknown = {
        d
        for s in slices.values()
        for d in s["depends_in_task"]
        if d not in slices
    }
    if unknown:
        die("зависимость на срез вне состава прогона: " + ", ".join(sorted(unknown)))

    state = {
        "task": task,
        "title": src.get("title") or args.title or task,
        "max_rework": args.max_rework,
        "slices": slices,
    }
    _detect_cycles(state)
    save(args.out, state)
    print(json.dumps({"task": task, "slices": len(slices)}, ensure_ascii=False))


def _detect_cycles(state):
    colour = {}

    def walk(node, path):
        if colour.get(node) == "done":
            return
        if colour.get(node) == "open":
            die("цикл в зависимостях срезов: " + " -> ".join(path + [node]))
        colour[node] = "open"
        for dep in state["slices"][node]["depends_in_task"]:
            walk(dep, path + [node])
        colour[node] = "done"

    for sid in state["slices"]:
        walk(sid, [])


# --------------------------------------------------------------------------- next


def _blocked_by(state, sid):
    """Незакрытые предшественники среза внутри задачи."""
    return [
        d
        for d in state["slices"][sid]["depends_in_task"]
        if state["slices"][d]["state"] != "passed"
    ]


def cmd_next(args):
    """Что диспатчить дальше.

    Порядок разбора: сначала обрыв по предшественникам, потом реализация,
    потом приёмка. Приёмка идёт одним сабагентом на все готовые срезы: единица
    прогона review-cycle - задача.
    """
    state = load(args.state)
    sl = state["slices"]

    # Срез, чей предшественник закрылся неуспешно, дальше не едет.
    cascade = []
    for sid, s in sl.items():
        if s["state"] in TERMINAL:
            continue
        dead = [d for d in s["depends_in_task"] if sl[d]["state"] in UNSUCCESSFUL]
        if dead:
            cascade.append({"slice": sid, "predecessors": dead})

    cascaded = {c["slice"] for c in cascade}
    implement, review, waiting = [], [], []
    notes = {}
    for sid, s in sl.items():
        if s["state"] in TERMINAL or sid in cascaded:
            continue
        blocked = _blocked_by(state, sid)
        if s["state"] in ("pending", "implementing"):
            if blocked:
                waiting.append({"slice": sid, "waits_for": blocked})
                continue
            cycle = s["cycle"]
            tz = _tz_of_cycle(s, cycle)
            if tz is None:
                waiting.append({"slice": sid, "waits_for": ["ТЗ цикла не записано"]})
                continue
            idx = s["done_parts"]
            if idx >= len(tz["files"]):
                continue
            implement.append(
                {
                    "slice": sid,
                    "repo": s["repo"],
                    "base_branch": s.get("base_branch"),
                    "contract": s.get("contract"),
                    "cycle": cycle,
                    "part": idx + 1,
                    "parts": len(tz["files"]),
                    "tz_file": tz["files"][idx],
                    "tz_path": tz["paths"][idx] if tz["paths"] else None,
                    # Часть 1 первичного цикла заводит ветку. Всё остальное
                    # продолжает ветку среза: части одного среза идут одной
                    # веткой и одним PR.
                    "mode": "new" if (cycle == 0 and idx == 0) else "rework",
                    "branch": s["branch"],
                    "pr": s["pr"],
                }
            )
        elif s["state"] == "implemented":
            review.append(sid)
            notes[sid] = f"rework-{s['cycle'] + 1}"
        elif s["state"] == "reworking":
            waiting.append({"slice": sid, "waits_for": ["ТЗ на доработку"]})

    if cascade:
        action = "cascade"
    elif implement:
        action = "implement"
    elif review:
        action = "review"
    elif waiting:
        action = "waiting"
    else:
        action = "done"

    out = {
        "action": action,
        "task": state["task"],
        "cascade": cascade,
        "implement": implement,
        "review": review,
        "next_notes": notes,
        "waiting": waiting,
        "terminal": {
            sid: {"state": s["state"], "reason": s["reason"]}
            for sid, s in sl.items()
            if s["state"] in TERMINAL
        },
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def _tz_of_cycle(s, cycle):
    for tz in s["tz"]:
        if tz["cycle"] == cycle:
            return tz
    return None


# ------------------------------------------------------------------------- record


def cmd_record(args):
    state = load(args.state)
    s = slice_of(state, args.slice)

    if args.drop:
        if not args.reason:
            die("--drop требует --reason")
        s["state"] = "dropped"
        s["reason"] = args.reason

    elif args.failed:
        s["state"] = "failed"
        s["reason"] = args.reason or "сабагент не вернул результат"

    elif args.implemented:
        if s["state"] not in ("pending", "implementing"):
            die(f"срез {args.slice} не в реализации: {s['state']}")
        tz = _tz_of_cycle(s, s["cycle"])
        if tz is None:
            die(f"у среза {args.slice} нет ТЗ цикла {s['cycle']}")
        s["done_parts"] += 1
        if args.branch:
            s["branch"] = args.branch
        if args.pr:
            s["pr"] = args.pr
        if s["done_parts"] >= len(tz["files"]):
            if not s["pr"]:
                die(
                    f"срез {args.slice}: все части реализованы, PR не назван - "
                    "приёмка сопоставляет PR по имени файла ТЗ, без PR ревью не идёт"
                )
            s["state"] = "implemented"
        else:
            s["state"] = "implementing"

    elif args.verdict:
        v = args.verdict.upper()
        if s["state"] != "implemented":
            die(f"срез {args.slice} не ждёт вердикта: {s['state']}")
        s["reviews"].append({"cycle": s["cycle"], "verdict": v})
        if v == "PASS":
            s["state"] = "passed"
        elif v in ("REWORK", "FAIL"):
            if s["cycle"] >= state["max_rework"]:
                s["state"] = "exhausted"
                s["reason"] = (
                    f"вердикт {v} после {state['max_rework']} циклов доработки"
                )
            else:
                s["state"] = "reworking"
        elif v in ("ESCALATE", "NO_PR", "FAILED"):
            s["state"] = "dropped"
            s["reason"] = args.reason or f"вердикт {v}"
        else:
            die(f"неизвестный вердикт: {v}")

    elif args.tz:
        if s["state"] != "reworking":
            die(f"срез {args.slice} не ждёт ТЗ на доработку: {s['state']}")
        if args.tz_path and len(args.tz_path) != len(args.tz):
            die("--tz-path задан не по одному на каждый --tz")
        s["cycle"] += 1
        s["done_parts"] = 0
        s["tz"].append(
            {"cycle": s["cycle"], "files": list(args.tz), "paths": list(args.tz_path or [])}
        )
        s["state"] = "pending"

    else:
        die("не назван ни один факт для записи")

    save(args.state, state)
    print(
        json.dumps(
            {
                "slice": args.slice,
                "state": s["state"],
                "cycle": s["cycle"],
                "done_parts": s["done_parts"],
                "reason": s["reason"],
            },
            ensure_ascii=False,
        )
    )


# ----------------------------------------------------------------------- tz-index


def cmd_tz_index(args):
    """Перечень всех файлов ТЗ прогона, по одному в строке.

    Заменяет листинг корня inbox для `new_tz.py --rework-auto --existing`:
    в сквозном прогоне ТЗ в inbox не коммитятся, и номер цикла доработки
    считается по прогону.
    """
    state = load(args.state)
    names = [f for s in state["slices"].values() for tz in s["tz"] for f in tz["files"]]
    text = "\n".join(names) + ("\n" if names else "")
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(json.dumps({"files": len(names), "out": args.out}, ensure_ascii=False))
    else:
        sys.stdout.write(text)


# ------------------------------------------------------------------------- report


def cmd_report(args):
    state = load(args.state)
    rows = []
    for sid, s in sorted(state["slices"].items()):
        rows.append(
            {
                "slice": sid,
                "repo": s["repo"],
                "base_branch": s.get("base_branch"),
                "contract": s.get("contract"),
                "state": s["state"],
                "cycles": s["cycle"],
                "verdicts": [r["verdict"] for r in s["reviews"]],
                "pr": s["pr"],
                "branch": s["branch"],
                "tz_files": [f for tz in s["tz"] for f in tz["files"]],
                "reason": s["reason"],
            }
        )
    summary = {
        "task": state["task"],
        "title": state["title"],
        "slices": len(rows),
        "passed": sum(1 for r in rows if r["state"] == "passed"),
        "open": sum(1 for r in rows if r["state"] not in TERMINAL),
        "unsuccessful": sum(1 for r in rows if r["state"] in UNSUCCESSFUL),
        "rows": rows,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="собрать состояние из результата spec-cycle")
    p.add_argument("--spec-result", required=True)
    p.add_argument("--task")
    p.add_argument("--title")
    p.add_argument("--max-rework", type=int, default=MAX_REWORK_DEFAULT)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("next", help="что диспатчить дальше")
    p.add_argument("--state", required=True)
    p.set_defaults(func=cmd_next)

    p = sub.add_parser("record", help="записать факт по срезу")
    p.add_argument("--state", required=True)
    p.add_argument("--slice", required=True)
    p.add_argument("--implemented", action="store_true")
    p.add_argument("--branch")
    p.add_argument("--pr")
    p.add_argument("--verdict")
    p.add_argument("--tz", action="append")
    p.add_argument("--tz-path", action="append")
    p.add_argument("--drop", action="store_true")
    p.add_argument("--failed", action="store_true")
    p.add_argument("--reason")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("tz-index", help="перечень файлов ТЗ прогона")
    p.add_argument("--state", required=True)
    p.add_argument("--out")
    p.set_defaults(func=cmd_tz_index)

    p = sub.add_parser("report", help="сводка состояния прогона")
    p.add_argument("--state", required=True)
    p.set_defaults(func=cmd_report)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
