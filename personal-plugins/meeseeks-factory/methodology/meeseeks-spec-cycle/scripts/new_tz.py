#!/usr/bin/env python3
"""Создание файла ТЗ с именем по шаблону репозитория meeseeks-claude-inbox.

Шаблон: `<окружение>.<id-среза>[.<пометка>][.part-<NN>-of-<MM>].tz.md`, например
`artifacts_service.as-2-s1.rework-5.tz.md` или
`identity_service.ic-7-s2.rework-3.part-02-of-03.tz.md`. Точка — разделитель
сегментов, поэтому внутри сегментов её нет. Скил имя не собирает руками:
собирает этот скрипт, скил передаёт поля и тело ТЗ.

Сегмент части появляется, когда ТЗ по одному репозиторию разрезано по бюджету
исполнения (см. tz_budget.py скила meeseeks-spec). Номер части дополняется нулём
слева: порядок исполнения задаётся сортировкой имён (tzpush публикует файлы
`sorted(glob)`, submit.sh проставляет монотонный штамп, воркер берёт первый файл
отсортированного pending), а без дополнения `part-10` встало бы перед `part-2`.

Идентификатор части — имя файла без суффикса `.tz.md`. Он же идёт трейлером
`Meeseeks-Part:` в каждый коммит части и по нему следующая часть проверяет своё
предусловие.

Usage:
    python scripts/new_tz.py --env artifacts_service --task CI-9-S1 --body body.md
    python scripts/new_tz.py --env nikell28/identity-client --task IC-4-S1 --note v2 --body -
    python scripts/new_tz.py --env dev_agent --task IC-7-S1 --rework-auto --existing inbox.txt --body b.md
    python scripts/new_tz.py --env mr_meeseeks --task CI-9-S1 --part 2 --parts 3 --body b.md
    python scripts/new_tz.py --env mr_meeseeks --task CI-9-S1 --part 2 --parts 3 --name-only
    python scripts/new_tz.py --list-envs

Выход: путь файла в outputs, путь в inbox (корень репозитория), идентификатор
части и идентификатор предыдущей части.
"""

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_ENVS = Path(__file__).with_name("envs.txt")
DEFAULT_OUTDIR = Path("/mnt/user-data/outputs")
SUFFIX = ".tz.md"
SEGMENT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PART_WIDTH = 2


def load_envs(path):
    p = Path(path)
    if not p.exists():
        raise SystemExit(f"Нет списка окружений: {p}")
    lines = [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines()]
    return [ln for ln in lines if ln and not ln.startswith("#")]


def normalize_env(raw, envs):
    value = raw.strip().lower().split("/")[-1].replace("-", "_")
    if value not in envs:
        raise SystemExit(
            f"Окружение «{raw}» не в списке.\n"
            f"Известные: {', '.join(envs)}\n"
            "Список ведётся в README репозитория nikell28/meeseeks-claude-inbox. "
            "Нет там — окружение заводит человек, скрипт его не придумывает."
        )
    return value


def normalize_segment(raw, field):
    value = raw.strip().lower().replace(" ", "-").replace("_", "-")
    if not value:
        raise SystemExit(f"Пустое поле {field}")
    if "." in value:
        raise SystemExit(
            f"Точка в поле {field}: «{raw}». Точка — разделитель сегментов имени. "
            "Передать через дефис: IC-7.5 → ic-7-5"
        )
    if not SEGMENT.match(value):
        raise SystemExit(
            f"Поле {field} = «{raw}» не проходит шаблон: только латиница, цифры и дефис"
        )
    return value


def check_part(part, parts_total):
    """Часть задаётся парой номер/всего. Одна часть из одной — не разрез."""
    if part is None and parts_total is None:
        return None, None
    if part is None or parts_total is None:
        raise SystemExit("--part и --parts задаются вместе")
    if parts_total < 2:
        raise SystemExit("--parts < 2: разреза нет, сегмент части не заводится")
    if not 1 <= part <= parts_total:
        raise SystemExit(f"--part {part} вне диапазона 1..{parts_total}")
    return part, parts_total


def part_segment(part, parts_total):
    width = max(PART_WIDTH, len(str(parts_total)))
    return f"part-{part:0{width}d}-of-{parts_total:0{width}d}"


def build_name(env, task, note, part, parts_total):
    segments = [env, task]
    if note:
        segments.append(note)
    if part:
        segments.append(part_segment(part, parts_total))
    return ".".join(segments) + SUFFIX


def read_body(src):
    text = sys.stdin.read() if src == "-" else Path(src).read_text(encoding="utf-8")
    if not text.strip():
        raise SystemExit("Тело ТЗ пустое — файл не создаётся")
    return text if text.endswith("\n") else text + "\n"


def next_rework(existing_src, task):
    """Номер цикла = максимум по уже лежащим в inbox ТЗ этого среза плюс один.

    На вход — перечень имён файлов inbox, по одному в строке (листинг корня
    репозитория). Разрез ТЗ на части номер цикла не увеличивает:
    `rework-3.part-01-of-02` и `rework-3.part-02-of-02` — один цикл.
    """
    text = sys.stdin.read() if existing_src == "-" \
        else Path(existing_src).read_text(encoding="utf-8")
    pattern = re.compile(
        r"^[a-z0-9_]+\." + re.escape(task) + r"\.rework-(\d+)"
        r"(?:\.part-\d+-of-\d+)?" + re.escape(SUFFIX) + r"$"
    )
    used = [int(m.group(1)) for line in text.splitlines()
            if (m := pattern.match(line.strip().split("/")[-1]))]
    return f"rework-{max(used) + 1 if used else 1}"


def check_no_gap(prev_name, outdir, existing_src, force):
    """Часть N > 1 не создаётся, пока нет файла части N-1.

    Дыра в нумерации ломает цепочку молча: часть N встанет на предусловии,
    и это выяснится только сгоревшим слотом воркера.
    """
    if force:
        return
    if (Path(outdir) / prev_name).exists():
        return
    if existing_src:
        text = sys.stdin.read() if existing_src == "-" \
            else Path(existing_src).read_text(encoding="utf-8")
        names = {ln.strip().split("/")[-1] for ln in text.splitlines() if ln.strip()}
        if prev_name in names:
            return
    raise SystemExit(
        f"Нет файла предыдущей части: {prev_name}\n"
        f"Искал в {outdir} и в --existing. Части создаются по порядку, "
        "с первой; пропуск ломает цепочку предусловий. Обход — --force."
    )


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--env", help="окружение или org/repo, например artifacts_service")
    ap.add_argument("--task", help="ID среза, например CI-9-S1")
    ap.add_argument("--note", default=None, help="свободная пометка, например rework-5 или v2")
    ap.add_argument("--rework-auto", action="store_true",
                    help="пометка rework-N, N считается по листингу inbox из --existing")
    ap.add_argument("--existing", default=None,
                    help="файл со списком имён файлов inbox или '-' для stdin")
    ap.add_argument("--note-only", action="store_true",
                    help="только посчитать пометку и напечатать её, файл не создавать")
    ap.add_argument("--name-only", action="store_true",
                    help="напечатать имя и идентификаторы части, файл не создавать; "
                         "нужен до написания тела: id части идёт внутрь ТЗ")
    ap.add_argument("--part", type=int, default=None,
                    help="номер части при разрезе ТЗ по бюджету исполнения")
    ap.add_argument("--parts", type=int, default=None,
                    help="всего частей; задаётся вместе с --part")
    ap.add_argument("--body", help="файл с телом ТЗ или '-' для stdin")
    ap.add_argument("--outdir", default=str(DEFAULT_OUTDIR))
    ap.add_argument("--envs", default=str(DEFAULT_ENVS))
    ap.add_argument("--force", action="store_true",
                    help="перезаписать существующий файл и не проверять предыдущую часть")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list-envs", action="store_true")
    args = ap.parse_args()

    envs = load_envs(args.envs)
    if args.list_envs:
        print("\n".join(envs))
        return

    if args.note_only:
        if not args.task:
            raise SystemExit("Не задано обязательное поле: --task")
        if not args.rework_auto or not args.existing:
            raise SystemExit("--note-only считает пометку по --rework-auto и --existing")
        print(next_rework(args.existing, normalize_segment(args.task, "--task")))
        return

    required = ("env", "task") if args.name_only else ("env", "task", "body")
    missing = [n for n in required if not getattr(args, n)]
    if missing:
        raise SystemExit(f"Не заданы обязательные поля: {', '.join('--' + m for m in missing)}")

    env = normalize_env(args.env, envs)
    task = normalize_segment(args.task, "--task")
    note = args.note
    if args.rework_auto:
        if note:
            raise SystemExit("--note и --rework-auto вместе не задаются")
        if not args.existing:
            raise SystemExit("--rework-auto требует --existing: листинг корня inbox")
        note = next_rework(args.existing, task)
    if note:
        note = normalize_segment(note, "--note")

    part, parts_total = check_part(args.part, args.parts)
    name = build_name(env, task, note, part, parts_total)
    prev_name = build_name(env, task, note, part - 1, parts_total) if part and part > 1 else None

    result = {
        "path": None,
        "inbox_path": name,
        "part_id": name[: -len(SUFFIX)],
        "prev_part_id": prev_name[: -len(SUFFIX)] if prev_name else None,
        "env": env,
        "task": task,
        "note": note,
        "part": part,
        "parts": parts_total,
        "bytes": 0,
    }

    if args.name_only:
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"Путь в inbox: {name}")
            print(f"Идентификатор части: {result['part_id']}")
            if result["prev_part_id"]:
                print(f"Предыдущая часть: {result['prev_part_id']}")
        return

    if prev_name:
        check_no_gap(prev_name, args.outdir, args.existing, args.force)

    body = read_body(args.body)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    dst = outdir / name
    if dst.exists() and not args.force:
        raise SystemExit(
            f"Файл уже есть: {dst}. Взять другую пометку (--note v2) или --force"
        )
    dst.write_text(body, encoding="utf-8")

    result["path"] = str(dst)
    result["bytes"] = len(body.encode("utf-8"))
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Файл ТЗ: {dst}")
        print(f"Путь в inbox: {name}")
        print(f"Идентификатор части: {result['part_id']}")
        if result["prev_part_id"]:
            print(f"Предыдущая часть: {result['prev_part_id']}")


if __name__ == "__main__":
    main()
