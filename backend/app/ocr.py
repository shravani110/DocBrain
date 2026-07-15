"""OCR for scanned pages and images.

Engine preference:
  1. PaddleOCR (layout-aware, best on dense multi-column policies/leases)
  2. Tesseract via pytesseract (fallback)
  3. None available -> caller records the page as un-OCR'd and the UI surfaces
     "OCR engine not installed" instead of silently indexing nothing.

Preprocessing (skew correction, contrast) runs BEFORE OCR, per spec.

Coordinates are mapped back into PDF-point space for PDF pages so highlight
rectangles line up with the rendered page regardless of OCR raster DPI.
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np

OCR_DPI = 300
_SCALE = OCR_DPI / 72.0  # raster pixels per PDF point

_paddle = None
_paddle_failed = False
_tesseract_checked = False
_tesseract_ok = False


def engine_name() -> Optional[str]:
    if _get_paddle() is not None:
        return "paddleocr"
    if _has_tesseract():
        return "tesseract"
    return None


def _get_paddle():
    global _paddle, _paddle_failed
    if _paddle is not None or _paddle_failed:
        return _paddle
    try:
        from paddleocr import PaddleOCR

        _paddle = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    except Exception:
        _paddle_failed = True
    return _paddle


def _has_tesseract() -> bool:
    global _tesseract_checked, _tesseract_ok
    if not _tesseract_checked:
        _tesseract_checked = True
        try:
            import pytesseract

            try:
                pytesseract.get_tesseract_version()
            except Exception:
                # Not on PATH -- try each platform's default install locations.
                import os

                for candidate in (
                    # Windows installers
                    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
                    # macOS Homebrew (Apple Silicon, then Intel)
                    "/opt/homebrew/bin/tesseract",
                    "/usr/local/bin/tesseract",
                    # Linux package managers
                    "/usr/bin/tesseract",
                ):
                    if os.path.exists(candidate):
                        pytesseract.pytesseract.tesseract_cmd = candidate
                        break
                pytesseract.get_tesseract_version()
            _tesseract_ok = True
        except Exception:
            _tesseract_ok = False
    return _tesseract_ok


# --- preprocessing -----------------------------------------------------------


def _preprocess(img: "np.ndarray") -> "np.ndarray":
    """Grayscale, autocontrast, deskew. Pure PIL/numpy -- no OpenCV dependency."""
    from PIL import Image, ImageOps

    pil = Image.fromarray(img).convert("L")
    pil = ImageOps.autocontrast(pil, cutoff=1)
    angle = _estimate_skew(np.asarray(pil))
    if abs(angle) > 0.4:
        pil = pil.rotate(-angle, expand=False, fillcolor=255)
    return np.asarray(pil.convert("RGB"))


def _estimate_skew(gray: "np.ndarray") -> float:
    """Projection-profile skew estimate over a small angle sweep (+-4 deg)."""
    from PIL import Image

    small = Image.fromarray(gray)
    small.thumbnail((800, 800))
    g = 255 - np.asarray(small, dtype=np.float32)  # ink = high
    best_angle, best_score = 0.0, -1.0
    for angle in np.arange(-4.0, 4.01, 0.5):
        rot = Image.fromarray(g.astype(np.uint8)).rotate(angle, fillcolor=0)
        rows = np.asarray(rot, dtype=np.float32).sum(axis=1)
        score = float(np.var(rows))
        if score > best_score:
            best_score, best_angle = score, float(angle)
    return best_angle


def _is_blank(img: "np.ndarray") -> bool:
    gray = img.mean(axis=2) if img.ndim == 3 else img
    return float(np.std(gray)) < 4.0


# --- OCR entry points --------------------------------------------------------


def ocr_pdf_page(page, pno: int) -> Optional[List["Span"]]:
    """Rasterize a PDF page at 300 DPI, OCR it, map boxes back to PDF points.
    Returns None if no OCR engine is available."""
    pix = page.get_pixmap(dpi=OCR_DPI)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        img = img[:, :, :3]
    if _is_blank(img):
        return []
    return _ocr_array(img, pno, scale=_SCALE)


def ocr_image_file(path: str) -> Optional[List["Span"]]:
    from PIL import Image

    img = np.asarray(Image.open(path).convert("RGB"))
    if _is_blank(img):
        return []
    # Image files are their own coordinate space: 1 px = 1 unit.
    return _ocr_array(img, 0, scale=1.0)


def _ocr_array(img: "np.ndarray", pno: int, scale: float) -> Optional[List["Span"]]:
    from .extract import Span

    img = _preprocess(img)

    paddle = _get_paddle()
    if paddle is not None:
        spans: List[Span] = []
        result = paddle.ocr(img, cls=True)
        for line in (result[0] or []) if result else []:
            box, (text, conf) = line
            if not text.strip() or conf < 0.4:
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            spans.append(Span(pno, min(xs) / scale, min(ys) / scale,
                              max(xs) / scale, max(ys) / scale, text))
        return spans

    if _has_tesseract():
        import pytesseract
        from PIL import Image

        spans = []
        data = pytesseract.image_to_data(Image.fromarray(img), output_type=pytesseract.Output.DICT)
        # Group words into lines by (block, par, line).
        lines = {}
        n = len(data["text"])
        for i in range(n):
            word = data["text"][i].strip()
            if not word or int(data.get("conf", ["-1"] * n)[i]) < 30:
                continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            x, y = data["left"][i], data["top"][i]
            w, h = data["width"][i], data["height"][i]
            entry = lines.setdefault(key, {"words": [], "x0": x, "y0": y, "x1": x + w, "y1": y + h})
            entry["words"].append(word)
            entry["x0"] = min(entry["x0"], x)
            entry["y0"] = min(entry["y0"], y)
            entry["x1"] = max(entry["x1"], x + w)
            entry["y1"] = max(entry["y1"], y + h)
        for key in sorted(lines):
            e = lines[key]
            spans.append(Span(pno, e["x0"] / scale, e["y0"] / scale,
                              e["x1"] / scale, e["y1"] / scale, " ".join(e["words"])))
        return spans

    return None  # no engine installed
