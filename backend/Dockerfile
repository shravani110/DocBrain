# Hosted-mode only. Render's native Python runtime has no apt-get access at
# all (verified: system package installs are blocked entirely there), so a
# real OCR engine can only get onto this platform via a Docker-based deploy,
# where we control the whole container and can install Tesseract ourselves.
# Local desktop installs never use this file -- OCR there just needs
# Tesseract installed on your own machine (see ocr.py's platform lookup).
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt requirements-cloud.txt ./
RUN pip install --no-cache-dir -r requirements-cloud.txt

COPY . .

# Render sets $PORT at runtime; shell-form CMD expands it (exec-form/JSON
# array CMD would not).
CMD uvicorn app.api_cloud:app --host 0.0.0.0 --port ${PORT:-8000}
