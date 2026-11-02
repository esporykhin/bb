#!/usr/bin/env python3
"""Сопоставление открытых PR со срезом по имени файла ТЗ в теле PR.

Связка PR со срезом — имя файла ТЗ вида
`<окружение>.<id-среза>[.<пометка>][.part-NN-of-MM].tz.md`: воркер, разобравший
inbox, кладёт его в тело PR, и ID среза в этом имени — целый сегмент. Ветка и
заголовок — запасной путь: часть веток несёт номер задачи, а у задачи несколько
срезов, идущих разными PR подряд.

Сопоставление вынесено в скрипт, потому что ID срезов — префиксы друг друга:
подстрочный поиск отдаёт на ревью PR по `CI-9-S10` под видом `CI-9-S1`. Здесь
сегмент имени сравнивается целиком, а в ветке и заголовке ID ищется по границе
токена.

Вход — `prs-raw.json`, массив объектов с полями `repo`, `number`, `title`,
`branch`, `base`, `body`, `draft`, `url`. Тело PR обязательно: без него связка не
читается, и такой PR уходит в `ambiguous` либо в `rejected`. База PR обязательна:
без неё PR в интеграционную ветку и PR в `master` неотличимы.

База сверяется с базовой веткой среза (`--base-branch`, из колонки «Репозиторий»
листа «Срезы»). Расхождение помечается полем `base_mismatch` и идёт находкой в
отчёт: вердикт по ней выносит ревью, здесь она только не теряется.

Классы выхода:
    matched    — `match`: `tz` (имя файла ТЗ), `branch`, `title`
    ambiguous  — ID среза виден только в теле, имени файла ТЗ нет
    rejected   — в теле ТЗ другого среза либо среза не видно нигде

`cycle` считается по пометке `rework-N` имён ТЗ этого среза: 0 — доработок ещё
не было, N — в работе N-й фикс. Пометка, посчитанная по inbox, должна быть на
единицу больше. Разрез на части номер цикла не увеличивает. Связка не через имя
файла ТЗ — `cycle: null`, номер определяет сабагент ревью.

Usage:
    python scripts/match_prs.py prs-raw.json CI-9-S1 --out prs.json

Exit codes:
    0 — сопоставление выполнено (в том числе когда не нашлось ничего)
    2 — вход не разобран
"""

import argparse
import json
import re
import sys
from pathlib import Path

SUFFIX = ".tz.md"
TZ_NAME = re.compile(r"(?<![0-9A-Za-z._-])([a-z0-9_]+(?:\.[a-z0-9-]+)+)\.tz\.md")
PART = re.compile(r"^part-(\d+)-of-(\d+)$")
REWORK = re.compile(r"^rework-(\d+)$")


def token(ident):
    return re.compile(
        r"(?<![0-9A-Za-zА-Яа-я-])" + re.escape(ident) + r"(?![0-9A-Za-zА-Яа-я])",
        re.IGNORECASE,
    )


def parse_tz(name):
    """Имя файла ТЗ -> {env, slice, note, part, parts}. Сегменты — между точками."""
    stem = name[: -len(SUFFIX)]
    segments = stem.split(".")
    if len(segments) < 2:
        return None
    out = {"name": name, "env": segments[0], "slice": segments[1],
           "note": None, "part": None, "parts": None, "rework": None}
    for seg in segments[2:]:
        m = PART.match(seg)
        if m:
            out["part"], out["parts"] = int(m.group(1)), int(m.group(2))
            continue
        out["note"] = seg
        r = REWORK.match(seg)
        if r:
            out["rework"] = int(r.group(1))
    return out


def classify(pr, slice_id, base_branch=None):
    body = pr.get("body") or ""
    branch = pr.get("branch") or ""
    title = pr.get("title") or ""
    target = slice_id.lower()

    names = [parse_tz(m.group(0)) for m in TZ_NAME.finditer(body)]
    names = [n for n in names if n]
    mine = [n for n in names if n["slice"] == target]
    foreign = sorted({n["slice"] for n in names if n["slice"] != target})

    base = pr.get("base") or None
    if base is None:
        base_mismatch = None
    elif base_branch is None:
        base_mismatch = None
    else:
        base_mismatch = base.strip() != base_branch.strip()

    entry = {
        "repo": pr.get("repo"),
        "number": pr.get("number"),
        "title": title,
        "branch": branch,
        "base": base,
        "slice_base_branch": base_branch,
        "base_mismatch": base_mismatch,
        "url": pr.get("url"),
        "draft": bool(pr.get("draft")),
        "match": None,
        "cycle": None,
        "tz_files": [n["name"] for n in mine],
        "note": None,
    }

    if mine:
        entry["match"] = "tz"
        entry["cycle"] = max([n["rework"] or 0 for n in mine])
        parts = sorted({n["parts"] for n in mine if n["parts"]})
        notes = []
        if foreign:
            notes.append("смешанные срезы: в теле названы ТЗ " + ", ".join(foreign))
        if parts:
            got = len([n for n in mine if n["part"]])
            notes.append(f"частей названо {got} из {parts[-1]}")
        entry["note"] = "; ".join(notes) or None
        return "matched", entry

    if foreign:
        entry["match"] = None
        entry["note"] = "PR по другому срезу: в теле ТЗ " + ", ".join(foreign)
        return "rejected", entry

    if token(slice_id).search(branch):
        entry["match"] = "branch"
        entry["note"] = "имени файла ТЗ в теле нет; номер цикла определяет ревью"
        return "matched", entry

    if token(slice_id).search(title):
        entry["match"] = "title"
        entry["note"] = "имени файла ТЗ в теле нет; номер цикла определяет ревью"
        return "matched", entry

    if token(slice_id).search(body):
        entry["match"] = "body"
        entry["note"] = ("ID среза только в теле, имени файла ТЗ нет — "
                         "подтвердить у человека до диспатча ревью")
        return "ambiguous", entry

    entry["note"] = "среза не видно ни в теле, ни в ветке, ни в заголовке"
    return "rejected", entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prs_raw", help="prs-raw.json: массив PR с телом")
    ap.add_argument("slice_id", help="ID среза, например CI-9-S1")
    ap.add_argument("--base-branch", dest="base_branch",
                    help="базовая ветка среза из колонки «Репозиторий» листа «Срезы»")
    ap.add_argument("--out")
    a = ap.parse_args()

    try:
        data = json.loads(Path(a.prs_raw).read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"Не разобран {a.prs_raw}: {e}", file=sys.stderr)
        return 2
    if isinstance(data, dict):
        data = data.get("pull_requests") or data.get("items") or []
    if not isinstance(data, list):
        print("Ожидался массив объектов PR", file=sys.stderr)
        return 2

    buckets = {"matched": [], "ambiguous": [], "rejected": []}
    bodyless, baseless, base_mismatches = [], [], []
    for pr in data:
        if pr.get("body") is None:
            bodyless.append(pr.get("number"))
        cls, entry = classify(pr, a.slice_id, a.base_branch)
        if cls != "rejected":
            if entry["base"] is None:
                baseless.append(entry["number"])
                note = "база PR не запрошена — PR в интеграционную ветку и PR в master неотличимы"
                entry["note"] = f"{entry['note']}; {note}" if entry["note"] else note
            elif entry["base_mismatch"]:
                base_mismatches.append({"number": entry["number"], "base": entry["base"],
                                        "slice_base_branch": a.base_branch})
                note = (f"база PR {entry['base']} не совпадает с базовой веткой среза "
                        f"{a.base_branch} — находка для отчёта")
                entry["note"] = f"{entry['note']}; {note}" if entry["note"] else note
        buckets[cls].append(entry)

    result = {
        "slice_id": a.slice_id,
        "source": a.prs_raw,
        "slice_base_branch": a.base_branch,
        "counts": {k: len(v) for k, v in buckets.items()},
        "bodyless_prs": bodyless,
        "baseless_prs": baseless,
        "base_mismatches": base_mismatches,
        **buckets,
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"{a.slice_id}: matched {len(buckets['matched'])}, "
              f"ambiguous {len(buckets['ambiguous'])}, rejected {len(buckets['rejected'])}")
        for e in buckets["matched"]:
            cyc = f"цикл {e['cycle']}" if e["cycle"] is not None else "цикл не определён"
            draft = " · draft" if e["draft"] else ""
            base = f" · база {e['base'] or 'не запрошена'}"
            print(f"  {e['repo']}#{e['number']} · match={e['match']} · {cyc}{base}{draft}")
            if e["note"]:
                print(f"    {e['note']}")
        for e in buckets["ambiguous"]:
            print(f"  ? {e['repo']}#{e['number']} · {e['note']}")
        for e in buckets["rejected"]:
            print(f"  − {e['repo']}#{e['number']} · {e['note']}")
        if bodyless:
            print(f"  тело не запрошено у PR: {bodyless} — связка по ним не читается")
        if a.base_branch is None:
            print("  базовая ветка среза не задана (--base-branch): "
                  "расхождение базы не проверено")
        if base_mismatches:
            print(f"  база PR расходится с базовой веткой среза {a.base_branch}: "
                  f"{[m['number'] for m in base_mismatches]} — находка для отчёта")
        print(f"Сопоставление: {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
