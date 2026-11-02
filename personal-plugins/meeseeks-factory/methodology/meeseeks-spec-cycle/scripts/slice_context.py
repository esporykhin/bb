#!/usr/bin/env python3
"""Контекст одного среза из файла проекта: строка среза, задача, реестр приёмки.

Разбор вынесен в скрипт, чтобы он не расходился между вызовами: одну и ту же
строку среза читают meeseeks-spec, meeseeks-review, meeseeks-fix-spec и оба
цикловых скила, и расхождение в том, какие кейсы считаются кейсами среза,
всплыло бы уже в готовом ТЗ или в вердикте ревью.

Вывод — черновик, не источник истины: листы «Решения», «Развилки», «Открытые
вопросы» и «Тесткейсы» скил читает сам. Скрипт ищет записи по упоминанию ID, а
инвариант бывает сформулирован без него.

Ячейка «Репозиторий» разбирается на репозиторий и базовую ветку среза; ветка не
распозналась — base_branch равен None, сырая ячейка лежит в repo_raw. С реестром
«Репозитории» сверяется сегмент репозитория, а не вся ячейка целиком.

ID сопоставляются по границе токена: `CI-9-S1` не совпадает с `CI-9-S10`.

Usage:
    python scripts/slice_context.py <project.xlsx> CI-9-S1 --out context.json

Exit codes:
    0 — контекст собран
    2 — среза с таким ID на листе «Срезы» нет
"""

import argparse
import json
import re
import sys
from pathlib import Path

import openpyxl

EMPTY = {"—", "-", "–", "", "none", "нет", "n/a"}
SPLIT = re.compile(r"[,;\n]+")
YES = {"да", "yes", "true", "1", "+", "замыкающий"}
DONE = "done"

# Ячейка «Репозиторий» листа «Срезы» несёт прозой и репозиторий, и базовую ветку
# среза: срез есть единица поставки, и куда он мержится — его собственное свойство.
# Разбор отдаёт то и другое порознь; не распозналось — None, а не умолчание.
REPO_SEG = re.compile(r"(?<![\w./-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)")
ONE_TOKEN = re.compile(r"^[A-Za-z0-9_.-]+$")
BRANCH_PATTERNS = [
    re.compile(r"базов\w*\s+ветк\w*\s*[:=-]?\s*([A-Za-z0-9_./-]+)", re.I),
    re.compile(r"ветк\w*\s+по\s+умолчани\w*\s*[:=-]?\s*([A-Za-z0-9_./-]+)", re.I),
    re.compile(r"base[\s_-]?branch\s*[:=-]?\s*([A-Za-z0-9_./-]+)", re.I),
    re.compile(r"default[\s_-]?branch\s*[:=-]?\s*([A-Za-z0-9_./-]+)", re.I),
]


def repo_segment(text):
    """Сегмент вида org/repo из прозы. Хост первым сегментом отбрасывается."""
    if not text:
        return None
    m = REPO_SEG.search(str(text))
    if m:
        parts = m.group(1).split("/")
        if len(parts) > 2 and "." in parts[0]:
            parts = parts[1:]
        return "/".join(parts).rstrip(".,;:")
    s = str(text).strip()
    return s if ONE_TOKEN.match(s) else None


def parse_repo_cell(raw):
    """Ячейка «Репозиторий» → репозиторий, базовая ветка, сырое значение.

    Базовая ветка не распозналась — base_branch равен None и сырая ячейка
    остаётся в raw: молчаливого отката на ветку по умолчанию репозитория нет.
    """
    value = norm(raw)
    if value is None:
        return {"repo": None, "base_branch": None, "raw": None}
    branch = None
    for pat in BRANCH_PATTERNS:
        m = pat.search(value)
        if m:
            branch = m.group(1).strip().rstrip(".,;:")
            break
    return {"repo": repo_segment(value), "base_branch": branch, "raw": value}


def norm(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if s.lower() in EMPTY else s


def find_header(ws, must_have, limit=10):
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


def row_dict(ws, hdr, cols, r):
    out = {}
    for title, c in cols.items():
        out[title] = norm(ws.cell(r, c).value)
    out["_row"] = r
    return out


def mentions(text, ident):
    """Упоминание ID по границе токена: CI-9 не ловится внутри CI-9-S1."""
    if not text or not ident:
        return False
    pattern = r"(?<![0-9A-Za-zА-Яа-я-])" + re.escape(ident) + r"(?![0-9A-Za-zА-Яа-я-])"
    return re.search(pattern, str(text)) is not None


def read_sheet(wb, name, must_have):
    if name not in wb.sheetnames:
        return None, None, None
    ws = wb[name]
    hdr = find_header(ws, must_have)
    return ws, hdr, cols_of(ws, hdr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("slice_id")
    ap.add_argument("--out")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    if "Срезы" not in wb.sheetnames:
        print("В файле проекта нет листа «Срезы»", file=sys.stderr)
        return 2

    sl_ws, sl_hdr, sl_cols = read_sheet(wb, "Срезы", ["ID"])
    c_id = sl_cols["ID"]
    c_parent = pick(sl_cols, "Родитель", contains="родител")
    c_repo = pick(sl_cols, "Репозиторий", contains="репозитор")
    c_deps = pick(sl_cols, "Зависит от", contains="зависит")
    c_status = pick(sl_cols, "Статус", contains="статус")
    c_closing = pick(sl_cols, "Замыкающий", contains="замыка")

    slices = {}
    for r in range(sl_hdr + 1, sl_ws.max_row + 1):
        sid = norm(sl_ws.cell(r, c_id).value)
        if sid:
            slices[sid] = r

    if a.slice_id not in slices:
        print(
            f"Среза «{a.slice_id}» на листе «Срезы» нет.\n"
            "Похожий ID не подбирается: CI-9-S1 и CI-9-S10 — разные срезы.",
            file=sys.stderr,
        )
        return 2

    row = slices[a.slice_id]
    slice_row = row_dict(sl_ws, sl_hdr, sl_cols, row)
    repo_cell = parse_repo_cell(sl_ws.cell(row, c_repo).value) if c_repo else \
        {"repo": None, "base_branch": None, "raw": None}
    repo = repo_cell["repo"]
    base_branch = repo_cell["base_branch"]
    parent = norm(sl_ws.cell(row, c_parent).value) if c_parent else None
    status = norm(sl_ws.cell(row, c_status).value) if c_status else None
    closing = (str(norm(sl_ws.cell(row, c_closing).value) or "").lower() in YES) \
        if c_closing else None

    def slice_field(sid, col):
        return norm(sl_ws.cell(slices[sid], col).value) if col else None

    # соседние срезы задачи: тот же родитель
    siblings = []
    task_slice_ids = []
    for sid, r in slices.items():
        if parent and slice_field(sid, c_parent) == parent:
            task_slice_ids.append(sid)
            if sid != a.slice_id:
                sib_repo = parse_repo_cell(sl_ws.cell(slices[sid], c_repo).value) \
                    if c_repo else {"repo": None, "base_branch": None, "raw": None}
                siblings.append({
                    "id": sid,
                    "repo": sib_repo["repo"],
                    "base_branch": sib_repo["base_branch"],
                    "status": slice_field(sid, c_status),
                    "closing": (str(slice_field(sid, c_closing) or "").lower() in YES)
                    if c_closing else None,
                })

    deps = []
    for dep in (split_ids(sl_ws.cell(row, c_deps).value) if c_deps else []):
        found = dep in slices
        deps.append({
            "id": dep,
            "found": found,
            "status": slice_field(dep, c_status) if found else None,
        })
    blocking = [d for d in deps
                if not d["found"] or (d["status"] or "").strip().lower() != DONE]

    # задача-родитель
    task = None
    if parent and "Задачи" in wb.sheetnames:
        t_ws, t_hdr, t_cols = read_sheet(wb, "Задачи", ["ID"])
        t_id = t_cols["ID"]
        for r in range(t_hdr + 1, t_ws.max_row + 1):
            if norm(t_ws.cell(r, t_id).value) == parent:
                task = row_dict(t_ws, t_hdr, t_cols, r)
                break

    # тест-кейсы
    testcases, task_testcases = [], []
    if "Тесткейсы" in wb.sheetnames:
        tc_ws, tc_hdr, tc_cols = read_sheet(wb, "Тесткейсы", ["TC-ID"])
        c_src = pick(tc_cols, "Источник", contains="источник")
        c_unit = pick(tc_cols, "Единица бэклога", contains="единица")
        for r in range(tc_hdr + 1, tc_ws.max_row + 1):
            tc = row_dict(tc_ws, tc_hdr, tc_cols, r)
            if not tc.get("TC-ID"):
                continue
            src = norm(tc_ws.cell(r, c_src).value) if c_src else None
            unit = norm(tc_ws.cell(r, c_unit).value) if c_unit else None
            if src == a.slice_id:
                testcases.append(tc)
            elif parent and unit == parent:
                task_testcases.append((src, tc))

    # кейсы задачи, не привязанные ни к одному её срезу — уровень стори
    unassigned = [tc for src, tc in task_testcases if src not in task_slice_ids]

    # решения с упоминанием ID среза или задачи
    decisions = []
    if "Решения" in wb.sheetnames:
        d_ws, d_hdr, d_cols = read_sheet(wb, "Решения", ["Решение"])
        for r in range(d_hdr + 1, d_ws.max_row + 1):
            values = [norm(d_ws.cell(r, c).value) for c in d_cols.values()]
            joined = " ".join(v for v in values if v)
            if not joined:
                continue
            hit_slice = mentions(joined, a.slice_id)
            hit_task = mentions(joined, parent) if parent else False
            if hit_slice or hit_task:
                d = row_dict(d_ws, d_hdr, d_cols, r)
                d["_mentions"] = ([a.slice_id] if hit_slice else []) + \
                                 ([parent] if hit_task else [])
                decisions.append(d)

    # развилки и открытые вопросы с упоминанием ID среза или задачи
    def mentioning(sheet, must_have):
        out = []
        if sheet not in wb.sheetnames:
            return out
        ws, hdr, cols = read_sheet(wb, sheet, must_have)
        for r in range(hdr + 1, ws.max_row + 1):
            values = [norm(ws.cell(r, c).value) for c in cols.values()]
            joined = " ".join(v for v in values if v)
            if not joined:
                continue
            hit_slice = mentions(joined, a.slice_id)
            hit_task = mentions(joined, parent) if parent else False
            if hit_slice or hit_task:
                item = row_dict(ws, hdr, cols, r)
                item["_mentions"] = ([a.slice_id] if hit_slice else []) + \
                                    ([parent] if hit_task else [])
                out.append(item)
        return out

    forks = mentioning("Развилки", ["ID"])
    open_questions = mentioning("Открытые вопросы", ["ID"])

    # контракты среза и его задачи: ID колонки «Контракт» → запись листа «Контракты»
    contract_records = {}
    if "Контракты" in wb.sheetnames:
        k_ws, k_hdr, k_cols = read_sheet(wb, "Контракты", ["ID"])
        k_id = k_cols["ID"]
        for r in range(k_hdr + 1, k_ws.max_row + 1):
            kid = norm(k_ws.cell(r, k_id).value)
            if kid:
                contract_records[kid] = row_dict(k_ws, k_hdr, k_cols, r)

    c_contract = pick(sl_cols, "Контракт", contains="контракт")
    slice_contract_ids = split_ids(sl_ws.cell(row, c_contract).value) if c_contract else []
    task_contract_ids = []
    if task:
        for title, value in task.items():
            if isinstance(title, str) and "контракт" in title.lower():
                task_contract_ids = split_ids(value)

    contracts = []
    seen_contracts = set()
    for src, ids in (("срез", slice_contract_ids), ("задача", task_contract_ids)):
        for kid in ids:
            if kid in seen_contracts:
                continue
            seen_contracts.add(kid)
            contracts.append({
                "id": kid,
                "source": src,
                "found": kid in contract_records,
                "record": contract_records.get(kid),
            })

    # репозиторий среза в реестре: сверяется сегмент репозитория, не вся ячейка
    repo_in_registry = None
    if repo and "Репозитории" in wb.sheetnames:
        rp_ws = wb["Репозитории"]
        known = set()
        for r in rp_ws.iter_rows():
            for cell in r:
                value = norm(cell.value)
                if not value:
                    continue
                for m in REPO_SEG.finditer(str(value)):
                    seg = repo_segment(m.group(1))
                    if seg:
                        known.add(seg.lower())
                        known.add(seg.split("/")[-1].lower())
                if ONE_TOKEN.match(value):
                    known.add(value.lower())
        repo_in_registry = repo.lower() in known or repo.split("/")[-1].lower() in known

    context = {
        "slice_id": a.slice_id,
        "source": a.xlsx,
        "repo": repo,
        "base_branch": base_branch,
        "repo_raw": repo_cell["raw"],
        "status": status,
        "closing": closing,
        "task_id": parent,
        "repo_in_registry": repo_in_registry,
        "slice": slice_row,
        "task": task,
        "sibling_slices": sorted(siblings, key=lambda s: s["id"]),
        "deps": deps,
        "blocking_deps": blocking,
        "testcases": testcases,
        "closing_testcases": unassigned if closing else [],
        "unassigned_task_testcases": [] if closing else unassigned,
        "decisions_mentioning_id": decisions,
        "forks_mentioning_id": forks,
        "open_questions_mentioning_id": open_questions,
        "contracts": contracts,
        "counts": {
            "testcases": len(testcases),
            "closing_testcases": len(unassigned) if closing else 0,
            "unassigned_task_testcases": 0 if closing else len(unassigned),
            "siblings": len(siblings),
            "deps": len(deps),
            "blocking_deps": len(blocking),
            "decisions": len(decisions),
            "forks": len(forks),
            "open_questions": len(open_questions),
            "contracts": len(contracts),
        },
    }

    text = json.dumps(context, ensure_ascii=False, indent=2, default=str)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"{a.slice_id} · {repo or 'репозиторий не указан'} · "
              f"база {base_branch or 'не распознана'} · "
              f"{status or 'статус пуст'}{' · замыкающий' if closing else ''}")
        print(f"Кейсов среза {len(testcases)}"
              f"{f', кейсов задачи вне срезов {len(unassigned)}' if unassigned else ''}"
              f", соседних срезов {len(siblings)}, зависимостей {len(deps)}"
              f" (не закрыто {len(blocking)}), решений с упоминанием {len(decisions)}"
              f", развилок {len(forks)}, открытых вопросов {len(open_questions)}"
              f", контрактов {len(contracts)}")
        if repo_in_registry is False:
            print("Репозитория нет на листе «Репозитории»")
        if repo_cell["raw"] and base_branch is None:
            print("Базовая ветка из ячейки «Репозиторий» не распознана — "
                  "стоп, вопрос человеку. Сырое значение: "
                  f"{repo_cell['raw']}")
        unknown = [c["id"] for c in contracts if not c["found"]]
        if unknown:
            print(f"Контрактов нет на листе «Контракты»: {', '.join(unknown)}")
        print(f"Контекст: {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
