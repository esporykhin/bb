#!/usr/bin/env python3
"""Оценка объёма ТЗ в вызовах инструментов и разрез на части.

Единица - вызов инструмента (turn): Bash, Read, Edit, Write. Это та же величина,
что `num_turns` в событии result и колонка TURNS в `mrctl ls`, и та же, что
ограничивает `--max-turns` воркера. Оценка скрипта и факт прогона сравнимы
напрямую, без переводных коэффициентов.

Потолок части - 100 вызовов, коридор 40-100, при `MAX_TURNS=150` в воркере.
Запас в 50 покрывает разброс между прогонами одного и того же ТЗ: первая попытка
sa-2-s1.rework-3 уложилась в 43 вызова, четвёртая упёрлась в 150.

Калибровка 2026-08-20 по `mrctl ls` и разбору лога
`artifacts_service.ch-1-s1.rework-3.part-05-of-12` (13 механических правок,
факт 50 вызовов при оценке 46). Завершённые части того периода: 64, 64, 76, 84,
94, 107. Коэффициенты уточняются по новым прогонам, число живёт только здесь.

До 2026-08-20 модель считала в «проходах агента» с потолком 25. Проход и вызов -
разные единицы, и оценка в проходах с TURNS из `mrctl ls` не сравнивалась.
Оценки ТЗ, написанных до этой даты, с нынешними несопоставимы.

Накладные повторяются в каждой части, потому что часть - отдельная сессия:
ориентация в репозитории, переключение на ветку, доведение CI до зелёного.
Первая часть новой работы дороже на создание ветки и PR; часть, продолжающая
существующий PR, - на проверку предусловия.

Usage:
    python3 tz_budget.py --limits --json
    python3 tz_budget.py --files-new 3 --files-edit 5 --tests-ui 6 --tests-e2e 1
    python3 tz_budget.py --files-mech 40 --tests-ui 2 --continuation --json
    python3 tz_budget.py --plan plan.json --json

Формат --plan: массив частей в порядке исполнения, каждая - объект со
счётчиками, полем name и необязательными флагами:

    [{"name": "домен и контракт", "files_new": 2, "tests_ui": 3},
     {"name": "оркестрация", "files_edit": 4, "tests_e2e": 1},
     {"name": "скаффолд пакета", "new_repos": 1, "atomic": true}]

Первая часть плана считается созданием ветки и PR, если не задан
--continuation (доработка открытого PR: тогда все части - продолжение).
`atomic: true` - часть неделима по существу (скаффолд репозитория, одна
миграция); превышение потолка на ней не ошибка, а факт, который пишется в ТЗ
строкой.

Выход: оценка по каждой части, вердикт, суммарная оценка. В одиночном режиме -
оценка целиком и рекомендованное число частей.
"""

import argparse
import json
import math
import sys
from pathlib import Path

CEILING = 100          # потолок одной части в вызовах инструментов
FLOOR = 40             # ниже этого часть сливается с соседней
MAX_TURNS = 150        # лимит воркера, с которым сверяется потолок

# Накладные части. Числа - вызовы инструментов, посчитанные по логам прогонов.
BASE = 6               # fetch, log, status, switch, чтение якорных файлов
BRANCH_NEW = 4         # switch -c, первый коммит, создание PR
BRANCH_CONT = 3        # fetch, проверка трейлера предусловия, switch
CI = 11                # локальные проверки по скоупу, push, опрос статуса, фикс
CI_NEW = 6             # надбавка: workflow заводится или меняется

OVERHEAD_FIRST = BASE + BRANCH_NEW + CI   # 21
OVERHEAD_CONT = BASE + BRANCH_CONT + CI   # 20

# Стоимость единицы работы в вызовах инструментов.
COST = {
    "files_new": 5,     # Write, прогон, правка по результату
    "files_edit": 4,    # чтение диапазонами, Edit, перечитывание после правки
    "files_mech": 2,    # Read + Edit по одному паттерну
    "migrations": 8,    # миграция схемы БД: файл, прогон, откат, повтор
    "infra": 5,         # Dockerfile, *.nomad.hcl, compose, workflow
    "new_repos": 25,    # скаффолд репозитория или пакета с нуля
    "tests_ui": 6,      # кейс типа U или I: написать, красная фаза, зелёная, фикс
    "tests_e2e": 12,    # кейс типа E: то же на тяжёлой обвязке
}

FIELDS = list(COST)

# Полезная работа, помещающаяся в одну часть-продолжение.
PAYLOAD_PER_PART = CEILING - OVERHEAD_CONT


def payload_of(counts):
    """Полезная работа части в проходах, без накладных."""
    total = 0
    breakdown = {}
    for field in FIELDS:
        n = int(counts.get(field, 0) or 0)
        if n:
            cost = n * COST[field]
            breakdown[f"{field} × {n}"] = cost
            total += cost
    return total, breakdown


def overhead_of(first, ci_new=False):
    return (OVERHEAD_FIRST if first else OVERHEAD_CONT) + (CI_NEW if ci_new else 0)


def estimate(counts, first=True, ci_new=False):
    """Оценка части в проходах агента: накладные плюс полезная работа."""
    over = overhead_of(first, ci_new)
    payload, breakdown = payload_of(counts)
    label = "накладные (ориентация, ветка/PR, CI)" if first \
        else "накладные (ориентация, предусловие/ветка, CI)"
    return over + payload, {label: over, **breakdown}


def parts_recommended(payload):
    """Число частей по полезной работе. Накладные повторяются в каждой."""
    if payload <= CEILING - OVERHEAD_FIRST:
        return 1
    return max(2, math.ceil(payload / PAYLOAD_PER_PART))


def verdict_for(turns, atomic=False):
    if turns > CEILING:
        return "over_atomic" if atomic else "over"
    if turns < FLOOR:
        return "small"
    return "ok"


def run_plan(raw, continuation):
    plan = json.loads(raw)
    if not isinstance(plan, list) or not plan:
        raise SystemExit("--plan ожидает непустой массив частей")
    parts = []
    for i, item in enumerate(plan, 1):
        first = (i == 1) and not continuation
        turns, breakdown = estimate(item, first=first, ci_new=item.get("ci_new", False))
        parts.append({
            "part": i,
            "of": len(plan),
            "name": item.get("name", f"часть {i}"),
            "first": first,
            "atomic": bool(item.get("atomic", False)),
            "turns": turns,
            "verdict": verdict_for(turns, item.get("atomic", False)),
            "breakdown": breakdown,
        })
    return {
        "mode": "plan",
        "parts": parts,
        "total_turns": sum(p["turns"] for p in parts),
        "ceiling": CEILING,
        "floor": FLOOR,
        "over": [p["part"] for p in parts if p["verdict"] == "over"],
        "over_atomic": [p["part"] for p in parts if p["verdict"] == "over_atomic"],
        "small": [p["part"] for p in parts if p["verdict"] == "small"],
    }


def main():
    ap = argparse.ArgumentParser(add_help=True)
    for field in FIELDS:
        ap.add_argument(f"--{field.replace('_', '-')}", type=int, default=0)
    ap.add_argument("--ci-new", action="store_true",
                    help="workflow CI заводится или меняется этой частью")
    ap.add_argument("--continuation", action="store_true",
                    help="работа продолжает существующие ветку и PR (доработка по ревью)")
    ap.add_argument("--atomic", action="store_true",
                    help="работа неделима по существу: превышение потолка — факт, не ошибка")
    ap.add_argument("--limits", action="store_true",
                    help="печатает потолок, пол и накладные — единственный источник этих чисел")
    ap.add_argument("--plan", default=None,
                    help="JSON-файл с разбивкой по частям или '-' для stdin")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.limits:
        limits = {
            "unit": "вызов инструмента (num_turns в mrctl ls, --max-turns воркера)",
            "ceiling": CEILING,
            "floor": FLOOR,
            "max_turns_worker": MAX_TURNS,
            "overhead_first": OVERHEAD_FIRST,
            "overhead_continuation": OVERHEAD_CONT,
            "payload_per_part": PAYLOAD_PER_PART,
            "cost": COST,
        }
        if args.json:
            print(json.dumps(limits, ensure_ascii=False, indent=2))
            return
        print(f"единица         {limits['unit']}")
        print(f"потолок части   {CEILING}")
        print(f"пол части       {FLOOR}")
        print(f"лимит воркера   {MAX_TURNS}")
        print(f"накладные       {OVERHEAD_FIRST} первая часть / {OVERHEAD_CONT} продолжение")
        return

    if args.plan:
        raw = sys.stdin.read() if args.plan == "-" \
            else Path(args.plan).read_text(encoding="utf-8")
        result = run_plan(raw, args.continuation)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        for p in result["parts"]:
            print(f"{p['part']}/{p['of']} · {p['name']}: {p['turns']} вызовов — {p['verdict']}")
        print(f"Сумма: {result['total_turns']}")
        if result["over"]:
            print(f"Сверх потолка {CEILING}: части {result['over']} — шов выбран не там")
        if result["over_atomic"]:
            print(f"Сверх потолка, помечены неделимыми: части {result['over_atomic']} — "
                  "назвать это в ТЗ строкой")
        if result["small"]:
            print(f"Ниже {FLOOR}: части {result['small']} — слить с соседней")
        return

    counts = {f: getattr(args, f) for f in FIELDS}
    first = not args.continuation
    turns, breakdown = estimate(counts, first=first, ci_new=args.ci_new)
    payload, _ = payload_of(counts)
    k = parts_recommended(payload)
    over = overhead_of(first, args.ci_new)
    result = {
        "mode": "single",
        "turns": turns,
        "payload": payload,
        "overhead": over,
        "continuation": args.continuation,
        "ceiling": CEILING,
        "floor": FLOOR,
        "verdict": verdict_for(turns, args.atomic),
        "parts_recommended": k,
        "per_part_estimate": turns if k == 1
        else math.ceil(payload / k) + OVERHEAD_CONT,
        "breakdown": breakdown,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    for key, value in breakdown.items():
        print(f"  {key}: {value}")
    print(f"Оценка: {turns} вызовов инструментов (потолок части {CEILING})")
    if result["verdict"] == "over":
        print(f"Резать на {k} части, ориентир на часть — {result['per_part_estimate']}")
    elif result["verdict"] == "over_atomic":
        print("Сверх потолка, но неделимо: одна часть, превышение назвать в ТЗ строкой")
    elif result["verdict"] == "small":
        print(f"Ниже {FLOOR}: сливается с соседней частью")
    else:
        print("Одна часть")


if __name__ == "__main__":
    main()
