"""
HealthIQ v2 — LLM Gateway (FastAPI Service)

Replaces the child-process-per-call pattern with a persistent HTTP service.
Eliminates process startup overhead.

Provider: Google Gemini (3-key rotation for resilience)
Endpoints:
  POST /llm/invoke  — Invoke LLM with task + prompt
  GET  /llm/health  — Health check

Preserves all v1 behavior:
- Key rotation on failure
- Rate limiting (token bucket)
- Disk cache (shelve)
- Strict JSON enforcement for registered tasks
- Simulation mode for dev/testing
"""

import os
import sys
import time
import json
import shelve
import hashlib
import threading
import logging
import importlib
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# --- Environment ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, ".env"))

# --- Logger ---
logger = logging.getLogger("healthiq.llm_service")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

# --- SDK import ---
GENAI_MODULE = None

for name in ["google.generativeai", "google.genai", "genai"]:
    try:
        spec = importlib.util.find_spec(name)
        if spec:
            GENAI_MODULE = importlib.import_module(name)
            break
    except Exception:
        pass

# --- Config ---
GEMINI_API_KEYS = [
    os.getenv("GEMINI_API_KEY", ""),
    os.getenv("GEMINI_API_KEY_2", ""),
    os.getenv("GEMINI_API_KEY_3", ""),
]
GEMINI_API_KEYS = [k for k in GEMINI_API_KEYS if k]
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

_CACHE_FILE_ENV = os.getenv("SENTIQ_CACHE_FILE", "sentiq_cache.db")
CACHE_FILE = _CACHE_FILE_ENV if os.path.isabs(_CACHE_FILE_ENV) else os.path.join(BASE_DIR, _CACHE_FILE_ENV)
RPM = int(os.getenv("SENTIQ_RPM", "120"))
LLM_SERVICE_PORT = int(os.getenv("LLM_SERVICE_PORT", "3002"))

# --- Task registry ---
_REGISTRY_PATH = os.path.join(BASE_DIR, "task_registry.json")
try:
    with open(_REGISTRY_PATH, "r", encoding="utf-8") as _f:
        _registry = json.load(_f)
    STRICT_JSON_TASKS = set(_registry.get("strict_json_tasks", []))
except Exception as _e:
    logger.error("Failed to load task_registry.json: %s", _e)
    STRICT_JSON_TASKS = set()

# --- Rate limiter ---
class TokenBucket:
    def __init__(self, rpm):
        self.capacity = rpm
        self.tokens = rpm
        self.rate = rpm / 60.0
        self.last = time.time()
        self.lock = threading.Lock()

    def consume(self, n=1):
        with self.lock:
            now = time.time()
            delta = now - self.last
            self.last = now
            self.tokens = min(self.capacity, self.tokens + delta * self.rate)
            if self.tokens >= n:
                self.tokens -= n
                return True
            return False

bucket = TokenBucket(RPM)

# --- Cache ---
def _cache_key(prompt: str, task: str, model: str, user_id: str = ""):
    h = hashlib.sha256()
    h.update(f"{task}|{model}|{user_id}|{prompt}".encode())
    return h.hexdigest()

# --- Simulation ---
def simulated_response(prompt: str, task: str) -> str:
    if task in STRICT_JSON_TASKS:
        return '{"status":"simulated","task":"' + task + '"}'
    return "SIMULATED RESPONSE"

# --- Gemini invocation ---
def _call_gemini(prompt: str, api_key: str, model: Optional[str] = None) -> str:
    if not GENAI_MODULE:
        raise RuntimeError("Gemini SDK not installed")
    if not api_key:
        raise RuntimeError("Gemini API key is empty")
    if not bucket.consume():
        raise RuntimeError("Rate limit exceeded")

    if hasattr(GENAI_MODULE, "configure"):
        GENAI_MODULE.configure(api_key=api_key)

    model_obj = GENAI_MODULE.GenerativeModel(model or GEMINI_MODEL)
    resp = model_obj.generate_content(prompt)
    return getattr(resp, "text", str(resp))

# --- Router ---
def call_llm_router(
    prompt: str,
    task: str = "general",
    use_simulation: bool = False,
    model_override: Optional[str] = None,
    user_id: Optional[str] = None,
) -> str:
    if use_simulation:
        return simulated_response(prompt, task)

    if not GEMINI_API_KEYS:
        logger.error("No Gemini API keys configured")
        return json.dumps({"error": "no_api_keys", "detail": "No GEMINI_API_KEY values found"})

    model = model_override or GEMINI_MODEL
    key = _cache_key(prompt, task, model, user_id or "")

    # Cache check
    try:
        with shelve.open(CACHE_FILE) as db:
            if key in db:
                logger.info("Cache hit for task=%s", task)
                return db[key]
    except Exception:
        pass

    # Enforce JSON if needed
    effective_prompt = prompt
    if task in STRICT_JSON_TASKS:
        effective_prompt = (
            "SYSTEM: Respond ONLY with valid JSON. "
            "No markdown. No explanations.\n\n" + prompt
        )

    # Key rotation
    last_error = None
    for idx, api_key in enumerate(GEMINI_API_KEYS, 1):
        try:
            result = _call_gemini(effective_prompt, api_key, model_override)
            # Cache result
            try:
                with shelve.open(CACHE_FILE) as db:
                    db[key] = result
            except Exception:
                pass
            logger.info("Gemini key #%d succeeded for task=%s", idx, task)
            return result
        except Exception as e:
            last_error = e
            logger.warning("Gemini key #%d failed: %s", idx, e)

    logger.error("All %d Gemini keys failed: %s", len(GEMINI_API_KEYS), last_error)
    return json.dumps({"error": "all_providers_failed", "detail": str(last_error)})


# ============================
# FastAPI Application
# ============================

app = FastAPI(title="HealthIQ LLM Service", version="2.0.0")

class LLMInvokeRequest(BaseModel):
    prompt: str
    task: str = "general"
    use_simulation: bool = False
    model_override: Optional[str] = None
    user_id: Optional[str] = None

class LLMInvokeResponse(BaseModel):
    result: str
    cached: bool = False

@app.get("/llm/health")
async def health_check():
    return {
        "status": "ok",
        "gemini_keys_configured": len(GEMINI_API_KEYS),
        "model": GEMINI_MODEL,
        "strict_json_tasks": len(STRICT_JSON_TASKS),
    }

@app.post("/llm/invoke", response_model=LLMInvokeResponse)
async def invoke_llm(request: LLMInvokeRequest):
    try:
        result = call_llm_router(
            prompt=request.prompt,
            task=request.task,
            use_simulation=request.use_simulation,
            model_override=request.model_override,
            user_id=request.user_id,
        )
        return LLMInvokeResponse(result=result)
    except Exception as e:
        logger.error("LLM invocation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# --- Backward-compatible stdin/stdout mode (for v1 compat) ---
def _run_stdin_mode():
    """Original v1 behavior: read JSON from stdin, write result to stdout."""
    payload = json.load(sys.stdin)
    out = call_llm_router(**payload)
    sys.stdout.write(out if isinstance(out, str) else str(out))


if __name__ == "__main__":
    # If --stdin flag is passed, run in v1 compatibility mode
    if "--stdin" in sys.argv:
        _run_stdin_mode()
    else:
        # Default: run as FastAPI HTTP service
        uvicorn.run(app, host="0.0.0.0", port=LLM_SERVICE_PORT, log_level="info")
