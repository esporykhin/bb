#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка страницы методологии Mr Meeseeks.

Методология здесь не хранится. Скрипт обходит каталог скилов, читает из фронтматтеров
поля `level` и `owns`, берёт из тела ровно те разделы, что названы в `section`, вырезает
из них размеченные примеры и раскладывает результат в порядке поля `frame` скила
`meeseeks-methodology`.

Только стандартная библиотека Python 3.

    python3 render.py --skills <каталог скилов> --out <файл.html>
"""

import argparse
import html
import os
import re
import sys

FRAME_SKILL = "meeseeks-methodology"

EXAMPLE_BLOCK_RE = re.compile(
    r"<!--\s*example:start\s*-->.*?<!--\s*example:end\s*-->", re.DOTALL
)
EXAMPLE_LINE_RE = re.compile(r"^\s*<!--\s*example:(start|end)\s*-->\s*$")
EXAMPLE_MARKER_RE = re.compile(r"<!--\s*example:(start|end)\s*-->")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


# --------------------------------------------------------------------------------------
# фронтматтер: минимальный разбор нужного подмножества YAML
# --------------------------------------------------------------------------------------

def split_front_matter(text):
    """Вернуть (фронтматтер, тело). Фронтматтер — список строк без разделителей."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return [], text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return lines[1:i], "\n".join(lines[i + 1:])
    return [], text


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse_front_matter(fm_lines):
    """Разбор фронтматтера: скаляры, блочные скаляры (> и |), списки строк и списков карт."""
    data = {}
    i = 0
    n = len(fm_lines)
    while i < n:
        line = fm_lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        m = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", line)
        if not m:
            i += 1
            continue
        key, rest = m.group(1), m.group(2).strip()
        i += 1
        if rest in (">", "|", ">-", "|-", ">+", "|+"):
            chunk = []
            while i < n and (not fm_lines[i].strip() or fm_lines[i].startswith((" ", "\t"))):
                chunk.append(fm_lines[i].strip())
                i += 1
            data[key] = " ".join(x for x in chunk if x)
        elif rest == "[]":
            data[key] = []
        elif rest:
            data[key] = unquote(rest)
        else:
            items = []
            while i < n and re.match(r"^\s*-\s", fm_lines[i]):
                item_line = fm_lines[i]
                indent = len(item_line) - len(item_line.lstrip())
                body = item_line.lstrip()[2:]
                i += 1
                mm = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", body.strip())
                if mm:
                    entry = {mm.group(1): unquote(mm.group(2))}
                    while i < n:
                        nxt = fm_lines[i]
                        if not nxt.strip():
                            break
                        nxt_indent = len(nxt) - len(nxt.lstrip())
                        if nxt_indent <= indent or re.match(r"^\s*-\s", nxt):
                            break
                        m2 = re.match(r"^\s*([A-Za-z0-9_.-]+):\s*(.*)$", nxt)
                        if not m2:
                            break
                        entry[m2.group(1)] = unquote(m2.group(2))
                        i += 1
                    items.append(entry)
                else:
                    items.append(unquote(body))
            data[key] = items
    return data


# --------------------------------------------------------------------------------------
# разделы и примеры
# --------------------------------------------------------------------------------------

def iter_headings(body):
    """Заголовки тела вне блоков кода: (индекс строки, уровень, текст)."""
    out = []
    fence = None
    for idx, line in enumerate(body.split("\n")):
        f = FENCE_RE.match(line)
        if f:
            token = f.group(1)[0]
            if fence is None:
                fence = token
            elif fence == token:
                fence = None
            continue
        if fence is not None:
            continue
        m = HEADING_RE.match(line)
        if m:
            out.append((idx, len(m.group(1)), m.group(2).strip()))
    return out


def extract_section(body, title):
    """Раздел по точному тексту заголовка: (уровень, содержимое без строки заголовка)."""
    lines = body.split("\n")
    heads = iter_headings(body)
    for pos, (idx, level, text) in enumerate(heads):
        if text == title:
            end = len(lines)
            for nidx, nlevel, _ in heads[pos + 1:]:
                if nlevel <= level:
                    end = nidx
                    break
            return level, "\n".join(lines[idx + 1:end])
    return None, None


def check_example_fences(text):
    """Проверка маркеров примеров. Возвращает список сообщений об ошибках."""
    errors = []
    line_marks = []
    for no, line in enumerate(text.split("\n"), 1):
        m = EXAMPLE_LINE_RE.match(line)
        if m:
            line_marks.append((no, m.group(1)))
            continue
        for _ in EXAMPLE_MARKER_RE.finditer(line):
            errors.append("маркер примера не на отдельной строке, строка %d" % no)
    depth = 0
    for no, kind in line_marks:
        if kind == "start":
            if depth:
                errors.append("вложенный example:start, строка %d" % no)
            depth += 1
        else:
            if depth == 0:
                errors.append("example:end без example:start, строка %d" % no)
            else:
                depth -= 1
    if depth:
        errors.append("незакрытый example:start (%d шт.)" % depth)
    return errors


def strip_examples(text):
    return EXAMPLE_BLOCK_RE.sub("", text)


# --------------------------------------------------------------------------------------
# markdown -> html: свой конвертер, внешних библиотек нет
# --------------------------------------------------------------------------------------

def esc(text):
    return html.escape(text, quote=True)


def inline(text):
    """Инлайн-разметка. Неизвестное отдаётся как есть, с экранированием."""
    out = []
    pos = 0
    for m in re.finditer(r"`+", text):
        if m.start() < pos:
            continue
        ticks = m.group(0)
        close = text.find(ticks, m.end())
        if close == -1:
            continue
        out.append(_inline_rest(text[pos:m.start()]))
        out.append("<code>%s</code>" % esc(text[m.end():close].strip()))
        pos = close + len(ticks)
    out.append(_inline_rest(text[pos:]))
    return "".join(out)


def _inline_rest(text):
    if not text:
        return ""
    text = esc(text)
    text = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        lambda m: '<a href="%s">%s</a>' % (m.group(2), m.group(1)),
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    return text


def split_row(line):
    row = line.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|"):
        row = row[:-1]
    return [c.strip() for c in row.split("|")]


def is_table_sep(line):
    return bool(re.match(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$", line)) and "-" in line


def markdown_to_html(md, heading_offset=1):
    """Конвертер под тот markdown, что встречается в скилах.

    heading_offset сдвигает заголовки взятого раздела в шкалу страницы: сам раздел стоит
    на странице как h3, вложенные заголовки идут ниже него.
    """
    lines = md.split("\n")
    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        fence = FENCE_RE.match(line)
        if fence:
            token = fence.group(1)[0]
            i += 1
            code = []
            while i < n and not (FENCE_RE.match(lines[i]) and FENCE_RE.match(lines[i]).group(1)[0] == token):
                code.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>%s</code></pre>" % esc("\n".join(code)))
            continue

        m = HEADING_RE.match(line)
        if m:
            level = min(6, max(4, len(m.group(1)) + heading_offset))
            out.append("<h%d>%s</h%d>" % (level, inline(m.group(2)), level))
            i += 1
            continue

        if re.match(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$", line):
            out.append("<hr>")
            i += 1
            continue

        if line.lstrip().startswith("|") and i + 1 < n and is_table_sep(lines[i + 1]):
            header = split_row(line)
            i += 2
            rows = []
            while i < n and lines[i].lstrip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            buf = ["<table><thead><tr>"]
            buf += ["<th>%s</th>" % inline(c) for c in header]
            buf.append("</tr></thead><tbody>")
            for row in rows:
                buf.append("<tr>")
                buf += ["<td>%s</td>" % inline(c) for c in row]
                buf.append("</tr>")
            buf.append("</tbody></table>")
            out.append("<div class=\"tablewrap\">%s</div>" % "".join(buf))
            continue

        bullet = re.match(r"^(\s*)([-*+])\s+(.*)$", line)
        number = re.match(r"^(\s*)(\d+)[.)]\s+(.*)$", line)
        if bullet or number:
            block, i = collect_list(lines, i, heading_offset)
            out.append(block)
            continue

        if line.lstrip().startswith(">"):
            quote = []
            while i < n and lines[i].lstrip().startswith(">"):
                quote.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote>%s</blockquote>"
                       % markdown_to_html("\n".join(quote), heading_offset))
            continue

        para = []
        while i < n and lines[i].strip() and not HEADING_RE.match(lines[i]) \
                and not FENCE_RE.match(lines[i]) \
                and not re.match(r"^(\s*)([-*+]|\d+[.)])\s+", lines[i]) \
                and not lines[i].lstrip().startswith("|") \
                and not lines[i].lstrip().startswith(">"):
            para.append(lines[i].strip())
            i += 1
        if para:
            out.append("<p>%s</p>" % inline(" ".join(para)))
        else:
            out.append("<p>%s</p>" % inline(lines[i].strip()))
            i += 1
    return "\n".join(out)


def collect_list(lines, i, heading_offset=1):
    """Список любой вложенности; продолжения пункта подклеиваются к пункту."""
    n = len(lines)
    first = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", lines[i])
    base_indent = len(first.group(1))
    ordered = not first.group(2) in "-*+"
    items = []          # (текст пункта, вложенные строки)
    while i < n:
        line = lines[i]
        if not line.strip():
            if i + 1 < n and re.match(r"^\s*([-*+]|\d+[.)])\s+", lines[i + 1]) \
                    and len(lines[i + 1]) - len(lines[i + 1].lstrip()) >= base_indent:
                i += 1
                continue
            break
        m = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line)
        indent = len(line) - len(line.lstrip())
        if m and indent == base_indent:
            items.append([m.group(3), []])
            i += 1
            continue
        if indent > base_indent and items:
            items[-1][1].append(line[base_indent:])
            i += 1
            continue
        if not m and indent >= base_indent and items:
            items[-1][1].append(line.strip())
            i += 1
            continue
        break

    tag = "ol" if ordered else "ul"
    buf = ["<%s>" % tag]
    for text, sub in items:
        sub_lines = []
        plain = []
        for s in sub:
            if re.match(r"^\s*([-*+]|\d+[.)])\s+", s) or sub_lines:
                sub_lines.append(s)
            else:
                plain.append(s.strip())
        body = inline(" ".join([text] + plain))
        inner = markdown_to_html("\n".join(sub_lines), heading_offset) if sub_lines else ""
        buf.append("<li>%s%s</li>" % (body, inner))
    buf.append("</%s>" % tag)
    return "".join(buf), i


# --------------------------------------------------------------------------------------
# страница
# --------------------------------------------------------------------------------------

def slug(text, prefix):
    s = re.sub(r"[^\w-]+", "-", text, flags=re.UNICODE).strip("-").lower()
    return "%s-%s" % (prefix, s) if s else prefix


CSS = """
:root{--bg:#fbfaf8;--fg:#1d1c1a;--muted:#6b6660;--line:#e2ded7;--card:#ffffff;
--accent:#7a5c3e;--codebg:#f2efe9;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
font-size:16px;line-height:1.6;}
.wrap{max-width:900px;margin:0 auto;padding:48px 24px 96px;}
header.page{border-bottom:2px solid var(--line);padding-bottom:24px;margin-bottom:32px;}
header.page h1{font-size:32px;margin:0 0 8px;letter-spacing:-.01em;}
header.page p{margin:4px 0;color:var(--muted);font-size:14px;}
nav.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:20px 24px;margin-bottom:48px;}
nav.toc h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 12px;
color:var(--muted);}
nav.toc ul{list-style:none;margin:0;padding:0;}
nav.toc>ul>li{margin-bottom:10px;}
nav.toc>ul>li>a{font-weight:600;}
nav.toc ul ul{margin:4px 0 0 16px;}
nav.toc ul ul li{font-size:14px;color:var(--muted);}
a{color:var(--accent);text-decoration:none;}
a:hover{text-decoration:underline;}
section.level{margin-bottom:56px;}
section.level>h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;
color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:8px;margin:0 0 24px;}
article.rule{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:24px 28px;margin-bottom:24px;}
article.rule>h3{margin:0 0 4px;font-size:22px;letter-spacing:-.01em;}
article.rule .meta{color:var(--muted);font-size:13px;margin:0 0 20px;
border-bottom:1px dashed var(--line);padding-bottom:12px;}
article.rule h4{font-size:17px;margin:24px 0 8px;}
article.rule h5,article.rule h6{font-size:15px;margin:20px 0 8px;}
p{margin:0 0 12px;}
ul,ol{margin:0 0 12px;padding-left:22px;}
li{margin-bottom:6px;}
code{background:var(--codebg);border-radius:4px;padding:1px 5px;font-size:.9em;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
pre{background:var(--codebg);border:1px solid var(--line);border-radius:8px;padding:14px 16px;
overflow-x:auto;}
pre code{background:none;padding:0;font-size:13px;line-height:1.5;}
.tablewrap{overflow-x:auto;margin:0 0 16px;}
table{border-collapse:collapse;width:100%;font-size:14px;}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;}
th{background:var(--codebg);font-weight:600;}
blockquote{margin:0 0 12px;padding:8px 16px;border-left:3px solid var(--line);
color:var(--muted);}
hr{border:0;border-top:1px solid var(--line);margin:20px 0;}
section.gaps{border:1px solid var(--line);border-radius:10px;background:var(--card);
padding:24px 28px;}
section.gaps h2{margin:0 0 16px;font-size:22px;}
section.gaps h3{font-size:15px;margin:20px 0 8px;color:var(--muted);
text-transform:uppercase;letter-spacing:.06em;}
section.gaps ul{padding-left:20px;}
.none{color:var(--muted);font-style:italic;}
footer.page{margin-top:48px;color:var(--muted);font-size:13px;text-align:center;}
@media (prefers-color-scheme:dark){
:root{--bg:#171614;--fg:#ece8e1;--muted:#a09a91;--line:#333029;--card:#1f1d1a;
--accent:#d3ac82;--codebg:#26241f;}
}
"""


def build_page(levels, gaps, stats):
    parts = []
    parts.append("<!doctype html>")
    parts.append('<html lang="ru"><head><meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    parts.append("<title>Методология Mr Meeseeks</title>")
    parts.append("<style>%s</style>" % CSS)
    parts.append("</head><body><div class=\"wrap\">")

    parts.append('<header class="page"><h1>Методология Mr Meeseeks</h1>')
    parts.append("<p>Страница собрана обходом скилов по объявлениям владения. "
                 "Источник каждого раздела — скил-владелец, правка делается там.</p>")
    parts.append("<p>Скилов обойдено: %d · правил собрано: %d · уровней: %d</p>"
                 % (stats["skills"], stats["rules"], len(levels)))
    parts.append("</header>")

    parts.append('<nav class="toc"><h2>Оглавление</h2><ul>')
    for level in levels:
        parts.append('<li><a href="#%s">%s</a><ul>' % (level["anchor"], esc(level["name"])))
        for rule in level["rules"]:
            parts.append('<li><a href="#%s">%s</a> · <span>%s</span></li>'
                         % (rule["anchor"], esc(rule["name"]), esc(rule["skill"])))
        parts.append("</ul></li>")
    parts.append('<li><a href="#gaps">Пропуски</a></li>')
    parts.append("</ul></nav>")

    for level in levels:
        parts.append('<section class="level" id="%s"><h2>Уровень: %s</h2>'
                     % (level["anchor"], esc(level["name"])))
        for rule in level["rules"]:
            parts.append('<article class="rule" id="%s">' % rule["anchor"])
            parts.append("<h3>%s</h3>" % esc(rule["name"]))
            parts.append('<p class="meta">правило <code>%s</code> · владелец <code>%s</code> '
                         '· раздел «%s»</p>'
                         % (esc(rule["name"]), esc(rule["skill"]), esc(rule["section"])))
            parts.append(rule["html"])
            parts.append("</article>")
        parts.append("</section>")

    parts.append('<section class="gaps" id="gaps"><h2>Пропуски</h2>')
    for title, items in gaps:
        parts.append("<h3>%s</h3>" % inline(title))
        if items:
            parts.append("<ul>%s</ul>" % "".join("<li>%s</li>" % inline(x) for x in items))
        else:
            parts.append('<p class="none">нет</p>')
    parts.append("</section>")

    parts.append('<footer class="page">Страница производна от скилов. '
                 'Расхождения не сглаживались при сборке.</footer>')
    parts.append("</div></body></html>")
    return "\n".join(parts)


# --------------------------------------------------------------------------------------
# сборка
# --------------------------------------------------------------------------------------

def collect_skills(skills_dir):
    skills = []
    for entry in sorted(os.listdir(skills_dir)):
        path = os.path.join(skills_dir, entry, "SKILL.md")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        fm_lines, body = split_front_matter(text)
        fm = parse_front_matter(fm_lines)
        skills.append({
            "dir": entry,
            "path": path,
            "name": fm.get("name") or entry,
            "level": fm.get("level"),
            "owns": fm.get("owns", None) if "owns" in fm else None,
            "has_owns": "owns" in fm,
            "owns_note": fm.get("owns-note"),
            "frame": fm.get("frame"),
            "text": text,
            "body": body,
        })
    return skills


def skill_label(sk):
    """Имя скила для «Пропусков»; `owns-note` скила приписывается рядом."""
    note = (sk.get("owns_note") or "").strip()
    return "%s - %s" % (sk["name"], note) if note else sk["name"]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_skills = os.path.dirname(os.path.dirname(here))

    ap = argparse.ArgumentParser(description="Сборка страницы методологии из скилов.")
    ap.add_argument("--skills", default=default_skills,
                    help="каталог со скилами (по умолчанию — каталог, где лежат скилы)")
    ap.add_argument("--out", default=os.path.join(os.getcwd(), "methodology.html"),
                    help="путь к выходному HTML-файлу")
    args = ap.parse_args()

    skills_dir = os.path.abspath(args.skills)
    if not os.path.isdir(skills_dir):
        print("ОШИБКА: каталог скилов не найден: %s" % skills_dir)
        return 2

    skills = collect_skills(skills_dir)

    errors = []
    gap_no_owns = []
    gap_empty_owns = []
    gap_missing_section = []
    gap_empty_section = []
    gap_unknown_level = []
    gap_level_no_rules = []

    # проверка маркеров примеров — по каждому файлу целиком
    for sk in skills:
        for err in check_example_fences(sk["text"]):
            errors.append("%s: %s" % (sk["name"], err))

    # каркас: порядок уровней
    frame = []
    frame_skill = next((s for s in skills if s["name"] == FRAME_SKILL), None)
    if frame_skill is None:
        errors.append("каркас %s не найден в каталоге скилов" % FRAME_SKILL)
    elif not frame_skill.get("frame"):
        errors.append("%s не объявил поле frame — порядок уровней страницы не задан"
                      % FRAME_SKILL)
    else:
        frame = [str(x) for x in frame_skill["frame"]]

    # владение: правило -> скил
    owner_of = {}
    rules = []
    for sk in skills:
        if not sk["has_owns"]:
            if sk["level"]:
                gap_no_owns.append(skill_label(sk))
            continue
        owns = sk["owns"] or []
        if not owns:
            gap_empty_owns.append(skill_label(sk))
            continue
        for item in owns:
            if not isinstance(item, dict):
                errors.append("%s: запись owns без полей name/section" % sk["name"])
                continue
            rname = item.get("name")
            rsection = item.get("section")
            if not rname or not rsection:
                errors.append("%s: запись owns без name или без section" % sk["name"])
                continue
            if rname in owner_of and owner_of[rname] != sk["name"]:
                errors.append("правило `%s` объявлено двумя скилами: %s и %s"
                              % (rname, owner_of[rname], sk["name"]))
                continue
            owner_of[rname] = sk["name"]

            level, content = extract_section(sk["body"], rsection)
            if content is None:
                gap_missing_section.append("`%s` — раздел «%s» не найден в теле скила %s"
                                           % (rname, rsection, sk["name"]))
                errors.append("%s: раздел «%s» правила `%s` не найден в теле скила"
                              % (sk["name"], rsection, rname))
                continue
            stripped = strip_examples(content)
            if EXAMPLE_MARKER_RE.search(stripped):
                errors.append(
                    "%s: в разделе «%s» правила `%s` остался маркер примера - блок "
                    "примера пересекает границу раздела" % (sk["name"], rsection, rname))
            if not stripped.strip():
                gap_empty_section.append(
                    "`%s` (%s) — раздел «%s» после вырезания примеров пуст: правило "
                    "сформулировано через пример" % (rname, sk["name"], rsection))
                continue
            rules.append({
                "name": rname,
                "section": rsection,
                "skill": sk["name"],
                "level": sk["level"] or "не объявлен",
                "html": markdown_to_html(stripped, heading_offset=3 - level),
                "anchor": slug(rname, "rule"),
            })

    # раскладка по уровням в порядке frame
    order = {name: i for i, name in enumerate(frame)}
    seen_levels = []
    for r in rules:
        if r["level"] not in seen_levels:
            seen_levels.append(r["level"])
    known = [lv for lv in frame if lv in seen_levels]
    unknown = [lv for lv in seen_levels if lv not in order]
    for lv in frame:
        if lv not in seen_levels:
            gap_level_no_rules.append(
                "уровень «%s» объявлен во frame скила %s, но правил нет: "
                "скила-владельца у уровня нет" % (lv, FRAME_SKILL))
    for lv in unknown:
        owners = sorted({r["skill"] for r in rules if r["level"] == lv})
        gap_unknown_level.append("уровень «%s» не объявлен во frame скила %s; скилы: %s"
                                 % (lv, FRAME_SKILL, ", ".join(owners)))

    levels = []
    for idx, lv in enumerate(known + unknown, 1):
        lv_rules = [r for r in rules if r["level"] == lv]
        lv_rules.sort(key=lambda r: (r["skill"],))
        levels.append({"name": lv, "anchor": "level-%d" % idx, "rules": lv_rules})

    gaps = [
        ("Скилы с объявленным `level`, но без `owns` — на страницу не попали",
         gap_no_owns),
        ("Скилы с `owns: []` — правил не несут", gap_empty_owns),
        ("Разделы, названные в `owns`, но не найденные в теле скила", gap_missing_section),
        ("Разделы, опустевшие после вырезания примеров", gap_empty_section),
        ("Уровни вне `frame` — вынесены в конец страницы", gap_unknown_level),
        ("Уровни `frame`, у которых нет ни одного правила", gap_level_no_rules),
    ]

    stats = {"skills": len(skills), "rules": len(rules)}
    page = build_page(levels, gaps, stats)

    out_path = os.path.abspath(args.out)
    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(page)

    # отчёт
    print("СТРАНИЦА МЕТОДОЛОГИИ")
    print("каталог скилов: %s" % skills_dir)
    print("файл: %s" % out_path)
    print("скилов обойдено: %d" % len(skills))
    print("правил собрано: %d" % len(rules))
    print("уровней на странице: %d (порядок из frame скила %s)" % (len(levels), FRAME_SKILL))
    print("")
    print("ПРОПУСКИ")
    any_gap = False
    for title, items in gaps:
        if not items:
            continue
        any_gap = True
        print("- %s:" % title)
        for x in items:
            print("    %s" % x)
    if not any_gap:
        print("- нет")
    print("")
    print("ОШИБКИ СБОРКИ")
    if errors:
        for e in errors:
            print("- %s" % e)
    else:
        print("- нет")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
