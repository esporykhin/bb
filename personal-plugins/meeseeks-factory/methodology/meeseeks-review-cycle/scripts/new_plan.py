#!/usr/bin/env python3
"""Файл плана задачи для диспетчера mrplan.

Формат плана задан диспетчером и здесь не расширяется:

    task: IC-10
    title: Обмен сервисных токенов
    tz:
      - id: s1-p1
        file: artifacts_service.ic-10-s1.part-01-of-02.tz.md
      - id: s1-p2
        file: artifacts_service.ic-10-s1.part-02-of-02.tz.md
        needs: [s1-p1]

Очередь в плане не указывается: диспетчер выводит её из первого сегмента имени
файла. Идентификатор вершины считается здесь и стабилен внутри плана:
`s<номер среза по порядку появления>-p<номер части>`.

Части одного среза связываются линейно автоматически. Рёбра между срезами
задаются вызывающим по колонке «Зависит от» листа «Срезы» и только для срезов
той же задачи: зависимости от срезов других задач в план не попадают.

Usage:
    python scripts/new_plan.py --task IC-10 --title "Обмен сервисных токенов" \\
      --tz artifacts_service.ic-10-s1.part-01-of-02.tz.md \\
      --tz artifacts_service.ic-10-s1.part-02-of-02.tz.md \\
      --tz mr_meeseeks.ci-9-s1.tz.md:needs=s1-p2 \\
      --out run/ic-10/ic-10.plan.yml

`--tz` принимает `<имя файла>[:needs=<id или имя файла>[,...]]`. Ссылаться можно
на идентификатор вершины или на имя файла ТЗ - имя разрешается в идентификатор.

Exit codes:
    0 — план собран
    2 — вход отвергнут: цикл, ссылка в никуда, имя не по шаблону ТЗ,
        имя файла плана не по шаблону задачи
"""

import argparse
import re
import sys
from pathlib import Path

TZ_NAME = re.compile(r"^[a-z0-9_]+(\.[a-z0-9][a-z0-9-]*)+\.tz\.md$")
PART = re.compile(r"^part-(\d+)-of-(\d+)$")
PLAIN_SCALAR = re.compile(r"^[A-Za-z0-9А-Яа-яЁё][^:#\n]*$")


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def parse_tz_arg(raw):
    """`<файл>[:needs=a,b]` -> (файл, [ссылки])."""
    file, sep, opts = raw.partition(":")
    file = file.strip()
    needs = []
    if sep:
        for chunk in opts.split(";"):
            chunk = chunk.strip()
            if not chunk:
                continue
            key, eq, value = chunk.partition("=")
            key = key.strip().lower()
            if not eq or key != "needs":
                fail(f"Непонятная опция «{chunk}» у --tz {file}. "
                     "Поддерживается только needs=<id или имя файла>[,...]")
            needs.extend(v.strip() for v in value.split(",") if v.strip())
    return file, needs


def slice_of(name):
    """ID среза - второй сегмент имени: `<окружение>.<срез>[...].tz.md`."""
    return name.split(".")[1]


def part_of(name):
    """(номер части, всего частей) либо (None, None)."""
    for seg in name.split("."):
        m = PART.match(seg)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None, None


def build_nodes(items):
    """Идентификаторы вершин и линейная сцепка частей внутри среза."""
    order = []
    by_slice = {}
    for file, needs in items:
        if not TZ_NAME.match(file):
            fail(f"Имя «{file}» не похоже на файл ТЗ: ожидается "
                 "<окружение>.<срез>[.<пометка>][.part-NN-of-MM].tz.md")
        sl = slice_of(file)
        if sl not in by_slice:
            by_slice[sl] = {"n": len(by_slice) + 1, "files": []}
        by_slice[sl]["files"].append(file)
        order.append({"file": file, "slice": sl, "needs_raw": needs})

    for sl, info in by_slice.items():
        total = len(info["files"])
        for i, file in enumerate(info["files"], start=1):
            num, of = part_of(file)
            if num is None:
                if total > 1:
                    fail(f"У среза {sl} в плане {total} файла, но «{file}» "
                         "без сегмента part-NN-of-MM: порядок частей не выражен")
                num = 1
            elif num != i or of != total:
                fail(f"Части среза {sl} перечислены не по порядку либо не полностью: "
                     f"«{file}» на позиции {i} из {total}")
            info.setdefault("ids", {})[file] = f"s{info['n']}-p{num}"

    ids_by_file = {}
    for sl, info in by_slice.items():
        ids_by_file.update(info["ids"])

    nodes = []
    for item in order:
        info = by_slice[item["slice"]]
        node = {"id": ids_by_file[item["file"]], "file": item["file"], "needs": []}
        nodes.append(node)

    # линейная сцепка частей одного среза
    prev_by_slice = {}
    for node, item in zip(nodes, order):
        prev = prev_by_slice.get(item["slice"])
        if prev:
            node["needs"].append(prev)
        prev_by_slice[item["slice"]] = node["id"]

    known = {n["id"] for n in nodes}
    if len(known) != len(nodes):
        fail("Идентификаторы вершин повторяются: в плане два файла с одним id")

    for node, item in zip(nodes, order):
        for ref in item["needs_raw"]:
            target = ref if ref in known else ids_by_file.get(ref)
            if target is None:
                target = ids_by_file.get(Path(ref).name)
            if target is None:
                fail(f"Вершина «{node['id']}» ссылается на «{ref}», "
                     f"которого в плане нет. Есть: {', '.join(sorted(known))}")
            if target == node["id"]:
                fail(f"Вершина «{node['id']}» ссылается сама на себя")
            if target not in node["needs"]:
                node["needs"].append(target)
    return nodes


def check_acyclic(nodes):
    incoming = {n["id"]: set(n["needs"]) for n in nodes}
    resolved = []
    pending = dict(incoming)
    while pending:
        ready = [i for i, deps in pending.items() if not deps - set(resolved)]
        if not ready:
            fail("Цикл в зависимостях плана: "
                 f"{', '.join(sorted(pending))} не раскладываются в порядок")
        for i in sorted(ready):
            resolved.append(i)
            pending.pop(i)
    return resolved


def scalar(value):
    if value is None:
        return '""'
    s = str(value).strip()
    if PLAIN_SCALAR.match(s) and not s.endswith(" "):
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render(task, title, nodes):
    lines = [f"task: {scalar(task)}", f"title: {scalar(title or task)}", "tz:"]
    for n in nodes:
        lines.append(f"  - id: {n['id']}")
        lines.append(f"    file: {n['file']}")
        if n["needs"]:
            lines.append(f"    needs: [{', '.join(n['needs'])}]")
    return "\n".join(lines) + "\n"


def check_out_name(out, task):
    """Имя плана привязано к задаче: иначе второй прогон затрёт первый."""
    name = Path(out).name
    low = task.lower()
    ok = re.compile(rf"^{re.escape(low)}(\.rework-\d+)?\.plan\.yml$")
    if not ok.match(name):
        fail(f"Имя файла плана «{name}» не по шаблону задачи {task}: "
             f"ожидается {low}.plan.yml либо {low}.rework-<N>.plan.yml")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, help="ID задачи, например IC-10")
    ap.add_argument("--title", help="название задачи")
    ap.add_argument("--tz", action="append", default=[],
                    help="<имя файла ТЗ>[:needs=<id или имя файла>[,...]]")
    ap.add_argument("--out", required=True, help="<задача в нижнем регистре>.plan.yml")
    a = ap.parse_args()

    if not a.tz:
        fail("План без ТЗ не собирается: задайте хотя бы один --tz")

    check_out_name(a.out, a.task)
    items = [parse_tz_arg(raw) for raw in a.tz]

    files = [f for f, _ in items]
    dup = {f for f in files if files.count(f) > 1}
    if dup:
        fail(f"Файл ТЗ повторяется в плане: {', '.join(sorted(dup))}")

    nodes = build_nodes(items)
    order = check_acyclic(nodes)

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(a.task, a.title, nodes), encoding="utf-8")

    edges = sum(len(n["needs"]) for n in nodes)
    print(f"План {out.name}: вершин {len(nodes)}, рёбер {edges}")
    for n in nodes:
        tail = f" ← {', '.join(n['needs'])}" if n["needs"] else ""
        print(f"  {n['id']} · {n['file']}{tail}")
    print(f"Порядок публикации: {' → '.join(order)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
