"""Document type classification (lease / insurance / tax / contract / other).

Keyword-scoring heuristic over the first ~2 pages of text. Deliberately simple
and transparent; users can always re-tag manually in the library view (the
`doc_type_source='manual'` flag protects their correction from being
overwritten on reprocess).
"""
from __future__ import annotations

from typing import List

from .extract import Span

DOC_TYPES = ["lease", "insurance", "tax", "contract", "other"]

_KEYWORDS = {
    "lease": [
        "lease", "landlord", "tenant", "lessee", "lessor", "rent", "premises",
        "security deposit", "renewal", "sublet", "eviction", "occupancy",
    ],
    "insurance": [
        "insurance", "policy", "insured", "insurer", "premium", "deductible",
        "coverage", "claim", "beneficiary", "underwriter", "endorsement", "peril",
    ],
    "tax": [
        "tax", "irs", "form 1040", "w-2", "1099", "deduction", "taxable",
        "withholding", "fiscal year", "adjusted gross income", "schedule c", "gst",
        "return", "assessment year",
    ],
    "contract": [
        "agreement", "contract", "party", "parties", "hereinafter", "whereas",
        "obligations", "termination", "indemnify", "governing law", "warranty",
        "consideration", "breach",
    ],
}

# Terms that appear in the query and imply a doc-type filter.
QUERY_TYPE_HINTS = {
    "lease": ["lease", "rent", "landlord", "tenant", "apartment", "deposit"],
    "insurance": ["insurance", "policy", "deductible", "premium", "coverage", "claim"],
    "tax": ["tax", "taxes", "irs", "1099", "w-2", "deduction", "refund"],
    "contract": ["contract", "agreement", "client", "nda", "invoice terms"],
}


def classify_document(spans: List[Span], filename: str = "") -> str:
    text_parts = [s.text.lower() for s in spans if s.page_number < 2]
    text = " ".join(text_parts) + " " + filename.lower()
    scores = {}
    for dtype, words in _KEYWORDS.items():
        scores[dtype] = sum(text.count(w) for w in words)
    best = max(scores, key=lambda k: scores[k])
    if scores[best] < 3:
        return "other"
    # "contract" keywords appear in leases/policies too; require a clear win.
    if best == "contract":
        runner_up = max((v for k, v in scores.items() if k != "contract"), default=0)
        if runner_up * 1.5 >= scores["contract"]:
            best = max((k for k in scores if k != "contract"), key=lambda k: scores[k])
            if scores[best] < 3:
                return "contract"
    return best


def infer_query_doc_types(query: str) -> List[str]:
    q = query.lower()
    hits = [dtype for dtype, words in QUERY_TYPE_HINTS.items() if any(w in q for w in words)]
    # Only filter when the query names exactly one domain; otherwise search all.
    return hits if len(hits) == 1 else []
