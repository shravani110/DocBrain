"""LLM answer generation with structurally enforced citations.

The model must return JSON: {"answer": ..., "citations": [{"chunk_id": ...,
"quoted_span": str}]}. chunk_id is an opaque identifier copied verbatim from
the prompt -- an int in local mode (SQLite), an alphanumeric string in
hosted mode (Firestore auto-ids) -- so it's matched by string form but
returned/compared using whichever type this process's chunk ids actually
are, never coerced to a single fixed type. Every quoted_span is validated
post-hoc against the
actual chunk text (fuzzy match to tolerate OCR noise and whitespace drift).
Citations that fail validation are dropped; if none survive, the answer
degrades to "no clear answer found" instead of shipping an unsupported claim.

Providers: Anthropic / OpenAI (BYOK, key in OS keychain) or Ollama (fully
local). Raw HTTP via httpx -- no provider SDKs to keep the sidecar lean.
"""
from __future__ import annotations

import difflib
import json
import os
import re
from typing import Any, Dict, List, Optional

import httpx

from .config import PROVIDER_DEFAULT_MODELS, get_api_key, load_settings

SYSTEM_PROMPT = """You are a document question-answering assistant. You answer questions ONLY from the provided document excerpts.

Rules — these are hard constraints:
1. Every factual claim in your answer MUST be supported by one of the provided excerpts.
2. If the excerpts do not contain the answer, say so. NEVER answer from general knowledge, and NEVER guess.
2b. If the question names a file (e.g. "resume.pdf"), treat it as a loose reference: any document whose name or content matches the description counts. Do not refuse just because the exact filename differs.
3. If excerpts from different documents disagree (e.g. two versions of a lease with different dates), report BOTH values and name the conflicting documents. Do not silently pick one.
3b. Be COMPLETE. If the question asks about a list or section (skills, exclusions, fees, coverage items), include EVERY item the excerpts contain for it — never just the first sub-list. Re-read the whole excerpt before answering. Use multiple citations when the answer spans several parts.
4. Respond with JSON only, exactly this shape:
{"answer": "<plain-english answer>", "citations": [{"chunk_id": <copy the exact chunk_id shown before that excerpt>, "quoted_span": "<verbatim quote from that excerpt supporting the claim>"}], "no_answer": <true if the excerpts do not answer the question>}
5. quoted_span must be copied VERBATIM from the excerpt text (a contiguous substring, max ~40 words).
6. chunk_id must be copied EXACTLY as shown in the excerpt header (e.g. [chunk_id=XXXX]) -- it may be a number or a short alphanumeric string, never invent or modify it.
7. Cite every excerpt you relied on. Do not cite excerpts you did not use."""


class LLMError(Exception):
    pass


def generate_answer(question: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Returns {answer, citations: [validated], no_answer, provider, model, raw_unsupported}."""
    settings = load_settings()
    # Hosted mode has no per-user /api/settings to persist llm_provider into
    # settings.json (there's no writable local file that means anything on a
    # server) -- an env var takes priority when present, same env-var-first
    # pattern as get_api_key(). No-op for existing local installs.
    provider = os.environ.get("LLM_PROVIDER") or settings.get("llm_provider", "none")
    if provider == "none":
        raise LLMError(
            "No answer model configured. Choose Ollama (local) or add an API key in Settings."
        )

    # Cap per-excerpt size so the prompt always fits the local model's context
    # window (oversized chunks can appear from OCR run-ons).
    excerpts = "\n\n".join(
        f"[chunk_id={c['id']}] (document: {c['filename']}, page {c['page_number'] + 1}"
        + (f", section: {c['section_heading']}" if c.get("section_heading") else "")
        + f")\n{c['text'][:1800]}"
        for c in chunks
    )
    user_msg = (
        f"Document excerpts:\n\n{excerpts}\n\nQuestion: {question}\n\n"
        "Answer COMPLETELY: scan every excerpt and include every item that answers "
        "the question (all sub-lists, all categories), not just the first match."
    )

    raw = _call_provider(provider, settings, SYSTEM_PROMPT, user_msg)
    parsed = _parse_json(raw)
    if parsed is None:
        # One retry with an explicit format reminder.
        raw = _call_provider(
            provider, settings, SYSTEM_PROMPT,
            user_msg + "\n\nIMPORTANT: respond with the JSON object only, no prose, no code fences.",
        )
        parsed = _parse_json(raw)
    if parsed is None:
        raise LLMError("Model did not return valid JSON after retry.")

    chunk_by_id = {c["id"]: c for c in chunks}
    validated, dropped = _validate_citations(parsed, chunk_by_id)

    if not validated and dropped > 0 and not parsed.get("no_answer"):
        # The model made claims but none of its quotes checked out.
        # One retry with explicit feedback before degrading.
        raw = _call_provider(
            provider, settings, SYSTEM_PROMPT,
            user_msg + "\n\nYour previous citations were rejected because quoted_span was "
            "not copied verbatim. Copy the supporting text EXACTLY as it appears in the "
            "excerpt, character for character, including odd symbols.",
        )
        retry_parsed = _parse_json(raw)
        if retry_parsed is not None:
            retry_validated, retry_dropped = _validate_citations(retry_parsed, chunk_by_id)
            if retry_validated:
                parsed, validated, dropped = retry_parsed, retry_validated, retry_dropped

    no_answer = bool(parsed.get("no_answer"))
    answer = str(parsed.get("answer", "")).strip()
    if not validated and not no_answer:
        # Model made claims it couldn't ground -> degrade honestly.
        no_answer = True
        answer = "I couldn't find a clear answer to this in your documents."

    return {
        "answer": answer,
        "citations": validated,
        "no_answer": no_answer,
        "provider": provider,
        "model": _model_for(provider, settings),
        "citations_dropped": dropped,
    }


def _validate_citations(parsed: Dict[str, Any], chunk_by_id: Dict[Any, Dict[str, Any]]):
    # chunk_by_id's keys are whatever type this process's chunk ids natively
    # are (int in local/SQLite mode, str in hosted/Firestore mode). The model
    # returns chunk_id as JSON, which may come back as a number or a string
    # regardless of which mode is running -- match by string form via this
    # lookup, but resolve back to the ORIGINAL key type so the returned
    # citation and everything downstream (api.py/api_cloud.py's own
    # chunk_by_id lookups, cited_ids set membership) keeps working with
    # whichever id type this mode actually uses.
    by_str_id = {str(k): k for k in chunk_by_id}

    validated, dropped = [], 0
    for cit in parsed.get("citations", []) or []:
        raw_cid = cit.get("chunk_id")
        cid = by_str_id.get(str(raw_cid).strip()) if raw_cid is not None else None
        if cid is None:
            dropped += 1
            continue
        span = str(cit.get("quoted_span", "")).strip()
        if not span:
            dropped += 1
            continue
        chunk = chunk_by_id.get(cid)
        matched = _find_span(span, chunk["text"]) if chunk else None
        if matched is None:
            # Small models often quote real text but attach the wrong chunk id.
            # Re-attribute to whichever retrieved chunk actually contains the
            # quote; if none does, the quote is invented and gets dropped.
            for other_id, other in chunk_by_id.items():
                if other_id == cid:
                    continue
                matched = _find_span(span, other["text"])
                if matched is not None:
                    cid = other_id
                    break
        if matched is None:
            dropped += 1
            continue
        validated.append({"chunk_id": cid, "quoted_span": matched})
    return validated, dropped


# --- span validation ----------------------------------------------------------


def _normalize(s: str) -> str:
    # Models sometimes decorate quotes with HTML/markdown; formatting doesn't
    # change content, so strip it before comparing.
    s = re.sub(r"</?[a-zA-Z][a-zA-Z0-9]*/?>", " ", s)
    s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    # Strip PDF/OCR junk (replacement chars, bullets, odd symbols) so a clean
    # model quote can still match noisy extracted text.
    s = re.sub(r"[^\w\s$%.,:;/@()&+\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def _find_span(span: str, chunk_text: str) -> Optional[str]:
    """Exact (whitespace-insensitive) or fuzzy (>=0.75 ratio) substring match.
    Returns the matching text as it appears in the chunk, or None."""
    norm_span, norm_chunk = _normalize(span), _normalize(chunk_text)
    if not norm_span:
        return None
    if norm_span in norm_chunk:
        return span
    # Fuzzy: slide a window of the span's word length across the chunk.
    span_words = norm_span.split()
    chunk_words = _normalize(chunk_text).split()
    w = len(span_words)
    if w == 0 or len(chunk_words) < 3:
        return None
    best_ratio, best_i = 0.0, -1
    for i in range(0, max(1, len(chunk_words) - w + 1)):
        window = " ".join(chunk_words[i:i + w])
        r = difflib.SequenceMatcher(None, norm_span, window).ratio()
        if r > best_ratio:
            best_ratio, best_i = r, i
    if best_ratio >= 0.75:
        return " ".join(chunk_words[best_i:best_i + w])
    return None


def _parse_json(raw: str) -> Optional[Dict[str, Any]]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            try:
                obj = json.loads(m.group(0))
                return obj if isinstance(obj, dict) else None
            except json.JSONDecodeError:
                return None
    return None


# --- providers ------------------------------------------------------------------


def _model_for(provider: str, settings: Dict[str, Any]) -> str:
    if provider == "local":
        return settings.get("ollama_model") or "llama3.1"
    return settings.get("llm_model") or PROVIDER_DEFAULT_MODELS.get(provider, "")


def _call_provider(provider: str, settings: Dict[str, Any], system: str, user: str) -> str:
    if provider == "anthropic":
        return _call_anthropic(settings, system, user)
    if provider == "openai":
        return _call_openai(settings, system, user)
    if provider == "gemini":
        return _call_gemini(settings, system, user)
    if provider == "local":
        return _call_ollama(settings, system, user)
    raise LLMError(f"Unknown provider: {provider}")


def _call_anthropic(settings, system: str, user: str) -> str:
    key = get_api_key("anthropic")
    if not key:
        raise LLMError("Anthropic API key not set. Add it in Settings.")
    try:
        resp = _post_anthropic(key, settings, system, user)
    except httpx.HTTPError as e:
        raise LLMError(f"Could not reach the Anthropic API: {type(e).__name__}")
    if resp.status_code != 200:
        raise LLMError(f"Anthropic API error {resp.status_code}: {resp.text[:300]}")
    return "".join(b.get("text", "") for b in resp.json().get("content", []))


def _post_anthropic(key, settings, system: str, user: str):
    return httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
        json={
            "model": _model_for("anthropic", settings),
            "max_tokens": 1500,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=120,
    )


def _call_openai(settings, system: str, user: str) -> str:
    key = get_api_key("openai")
    if not key:
        raise LLMError("OpenAI API key not set. Add it in Settings.")
    try:
        resp = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": _model_for("openai", settings),
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout=120,
        )
    except httpx.HTTPError as e:
        raise LLMError(f"Could not reach the OpenAI API: {type(e).__name__}")
    if resp.status_code != 200:
        raise LLMError(f"OpenAI API error {resp.status_code}: {resp.text[:300]}")
    return resp.json()["choices"][0]["message"]["content"]


def _call_gemini(settings, system: str, user: str) -> str:
    key = get_api_key("gemini")
    if not key:
        raise LLMError("Gemini API key not set. Add it in Settings.")
    model = _model_for("gemini", settings)
    try:
        resp = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            params={"key": key},
            json={
                "system_instruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 0.1,
                },
            },
            timeout=120,
        )
    except httpx.HTTPError as e:
        raise LLMError(f"Could not reach the Gemini API: {type(e).__name__}")
    if resp.status_code != 200:
        raise LLMError(f"Gemini API error {resp.status_code}: {resp.text[:300]}")
    candidates = resp.json().get("candidates", [])
    if not candidates:
        raise LLMError("Gemini returned no candidates (likely blocked by safety filters).")
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def _call_ollama(settings, system: str, user: str) -> str:
    url = (settings.get("ollama_url") or "http://localhost:11434").rstrip("/")
    try:
        resp = httpx.post(
            f"{url}/api/chat",
            json={
                "model": _model_for("local", settings),
                "stream": False,
                "format": "json",
                # Extraction task: near-deterministic decoding beats the
                # creative default (0.8) for completeness and JSON fidelity.
                # 4096 ctx keeps CPU prefill fast; excerpts are sized to fit.
                "options": {"temperature": 0.1, "num_ctx": 4096, "num_predict": 700},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout=600,
        )
    except httpx.ConnectError:
        raise LLMError(
            f"Cannot reach Ollama at {url}. Is Ollama running? (ollama serve)"
        )
    except httpx.TimeoutException:
        raise LLMError(
            "The local model took too long to answer on this machine. "
            "Try again (the model stays warm), ask a narrower question, "
            "or switch to a cloud model in Settings for faster answers."
        )
    if resp.status_code != 200:
        raise LLMError(f"Ollama error {resp.status_code}: {resp.text[:300]}")
    return resp.json().get("message", {}).get("content", "")
