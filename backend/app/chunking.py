"""Layout-aware chunking.

Spans (lines with bounding boxes) are grouped into paragraphs using vertical
gaps and heading markers, then paragraphs are packed into chunks of roughly
200-500 tokens with ~15% overlap. Chunks never split a paragraph in the
middle unless a single paragraph alone exceeds the max size.

Every chunk carries: text, page_number (first page it touches), the bounding
boxes of every line it contains, and the nearest preceding section heading.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .extract import Span

TARGET_MIN_TOKENS = 200
TARGET_MAX_TOKENS = 500
OVERLAP_RATIO = 0.15

# Vertical gap (in units of median line height) that starts a new paragraph.
PARA_GAP_FACTOR = 0.9


def _tokens(text: str) -> int:
    # Cheap token estimate: words * 1.3 approximates BPE token counts closely
    # enough for chunk sizing.
    return max(1, int(len(text.split()) * 1.3))


@dataclass
class Paragraph:
    spans: List[Span] = field(default_factory=list)
    is_heading: bool = False

    @property
    def text(self) -> str:
        return " ".join(s.text.strip() for s in self.spans if s.text.strip())

    @property
    def page_number(self) -> int:
        return self.spans[0].page_number if self.spans else 0


def group_paragraphs(spans: List[Span]) -> List[Paragraph]:
    if not spans:
        return []
    ordered = sorted(spans, key=lambda s: (s.page_number, s.y0, s.x0))
    heights = sorted((s.y1 - s.y0) for s in ordered if s.y1 > s.y0)
    med_h = heights[len(heights) // 2] if heights else 12.0

    paras: List[Paragraph] = []
    current = Paragraph()
    prev: Span = None  # type: ignore
    for sp in ordered:
        new_para = False
        if prev is None:
            new_para = False
        elif sp.page_number != prev.page_number:
            new_para = True
        elif sp.is_heading != prev.is_heading:
            new_para = True
        elif (sp.y0 - prev.y1) > med_h * PARA_GAP_FACTOR:
            new_para = True
        if new_para and current.spans:
            current.is_heading = all(s.is_heading for s in current.spans)
            paras.append(current)
            current = Paragraph()
        current.spans.append(sp)
        prev = sp
    if current.spans:
        current.is_heading = all(s.is_heading for s in current.spans)
        paras.append(current)
    return paras


def make_chunks(spans: List[Span]) -> List[dict]:
    """Returns chunk dicts ready for db.insert_chunks()."""
    paras = group_paragraphs(spans)
    chunks: List[dict] = []
    buf: List[Paragraph] = []
    buf_tokens = 0
    section = ""

    def flush(overlap_from: List[Paragraph]) -> List[Paragraph]:
        nonlocal buf, buf_tokens
        body = [p for p in buf if p.text]
        if body:
            text = "\n".join(p.text for p in body)
            # 6th element is the line's own text, so a citation can highlight
            # only the lines belonging to its quoted span (not the whole chunk).
            bboxes = [
                [s.page_number, round(s.x0, 2), round(s.y0, 2), round(s.x1, 2),
                 round(s.y1, 2), s.text.strip()]
                for p in body for s in p.spans
            ]
            chunks.append({
                "text": text,
                "page_number": body[0].page_number,
                "bboxes": bboxes,
                "section_heading": section,
            })
        # Overlap: carry the tail paragraphs (~15% of target) into next chunk.
        carry: List[Paragraph] = []
        carry_tokens = 0
        budget = int(TARGET_MAX_TOKENS * OVERLAP_RATIO)
        for p in reversed(overlap_from):
            t = _tokens(p.text)
            if carry_tokens + t > budget or p.is_heading:
                break
            carry.insert(0, p)
            carry_tokens += t
        buf = list(carry)
        buf_tokens = carry_tokens
        return carry

    for p in paras:
        if p.is_heading:
            # Headings close the current chunk and set context for the next.
            if buf_tokens >= TARGET_MIN_TOKENS:
                flush(buf)
                buf, buf_tokens = [], 0
            section = p.text[:120]
            buf.append(p)
            buf_tokens += _tokens(p.text)
            continue
        t = _tokens(p.text)
        if buf_tokens + t > TARGET_MAX_TOKENS and buf_tokens >= TARGET_MIN_TOKENS:
            flush(buf)
        buf.append(p)
        buf_tokens += t
        # A single huge paragraph (e.g. OCR run-on): hard-split by sentences.
        while buf_tokens > TARGET_MAX_TOKENS * 1.6 and len(buf) == 1:
            flush(buf)
            buf, buf_tokens = [], 0
            break

    if buf_tokens > 0:
        flush(buf)
    return chunks
