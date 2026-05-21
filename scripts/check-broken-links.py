#!/usr/bin/env python3
"""
Check for broken internal markdown links in given files.

Usage:
    python3 scripts/check-broken-links.py FILE [FILE ...]

Exit codes:
    0 — all internal relative links resolve
    1 — broken links found
    2 — usage error

Scope:
    - Inline links `[label](path)`, reference defs `[label]: path`,
      and HTML href/src attributes.
    - Relative paths only. External URLs (http/https/mailto/etc.) skipped.
    - Path existence is verified; anchors are NOT validated (off by default,
      anchor validation is high-cost low-value for a small public repo).

Invoked by `.githooks/pre-commit` on staged markdown-like files.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

INLINE_LINK_RE = re.compile(r'!?\[([^\]]+)\]\(([^)]+)\)')
REFERENCE_DEF_RE = re.compile(r'^\s*\[(?!\^)([^\]]+)\]:\s*(\S+)', re.MULTILINE)
HTML_ATTR_RE = re.compile(r'<[A-Za-z][^>]*\s(?:href|src)=["\']([^"\']+)["\']', re.IGNORECASE)
SCHEME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')
LINE_SUFFIX_RE = re.compile(r':\d+(?:[-:]\d+)?$')
MARKDOWN_SUFFIXES = frozenset({'.md', '.mdc'})


def _blank_preserving_newlines(m: re.Match[str]) -> str:
    return ''.join('\n' if ch == '\n' else ' ' for ch in m.group(0))


def mask_code(text: str) -> str:
    text = re.sub(r'(^|\n)(`{3,}|~{3,})[\s\S]*?(\n\2[^\n]*|$)', _blank_preserving_newlines, text)
    return re.sub(r'`[^`\n]+`', _blank_preserving_newlines, text)


def is_external(href: str) -> bool:
    return href.startswith('//') or href.startswith('/') or bool(SCHEME_RE.match(href))


def normalize_href(href: str) -> str:
    href = href.strip()
    if href.startswith('<') and href.endswith('>'):
        href = href[1:-1].strip()
    if '{' in href and '}' in href:
        return ''
    path_part = href.partition('#')[0]
    return LINE_SUFFIX_RE.sub('', unquote(path_part))


def candidates(text: str) -> list[tuple[int, str, str]]:
    text = mask_code(text)
    out: list[tuple[int, str, str]] = []
    for m in INLINE_LINK_RE.finditer(text):
        out.append((m.start(), m.group(1)[:50], m.group(2).strip()))
    for m in REFERENCE_DEF_RE.finditer(text):
        raw = m.group(2).strip()
        href = raw[1:raw.index('>')] if raw.startswith('<') and '>' in raw else raw.split(None, 1)[0]
        out.append((m.start(), m.group(1)[:50], href))
    for m in HTML_ATTR_RE.finditer(text):
        out.append((m.start(), '<html href/src>', m.group(1).strip()))
    return out


def scan(path: Path) -> list[tuple[int, str, str]]:
    try:
        text = path.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError) as e:
        print(f"warn: cannot read {path}: {e}", file=sys.stderr)
        return []
    broken: list[tuple[int, str, str]] = []
    for offset, label, href_full in candidates(text):
        if not href_full:
            continue
        href = normalize_href(href_full)
        if not href or is_external(href):
            continue
        target = (path.parent / href).resolve()
        if not target.exists():
            line = text[:offset].count('\n') + 1
            broken.append((line, label, href_full))
    return broken


def main() -> int:
    args = [Path(p) for p in sys.argv[1:]]
    if not args:
        print("usage: check-broken-links.py FILE [FILE ...]", file=sys.stderr)
        return 2

    scanned = 0
    total_broken = 0
    files_with_broken = 0
    for path in args:
        if not path.exists():
            print(f"warn: path does not exist: {path}", file=sys.stderr)
            continue
        if path.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        scanned += 1
        broken = scan(path)
        if broken:
            files_with_broken += 1
            total_broken += len(broken)
            print(f"❌ {path} ({len(broken)} broken)")
            for line, label, href in broken:
                print(f"     L{line}: [{label}] -> {href}")

    print(f"\nScanned: {scanned} files | Broken: {total_broken} links across {files_with_broken} files")
    return 1 if total_broken else 0


if __name__ == '__main__':
    sys.exit(main())
