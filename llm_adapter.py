# llm_adapter.py
"""
HealthIQ — Unified LLM Gateway (Production)

Provider:
- Google Gemini (3-key rotation for resilience)
  Key 1 (primary) → Key 2 (fallback) → Key 3 (fallback)

Design goals:
- Strict JSON where required
- Task-aware routing
- Automatic key rotation on failure
- Backward compatibility
"""

import os
import time
import json
import shelve
import hashlib
import threading
import logging
import importlib
from typing import Optional

# ------------------------------
# Optional SDK imports
# ------------------------------
GENAI_MODULE = None
GENAI_CLIENT_FACTORY = None

for name in ["google.generativeai", "google.genai", "genai"]:
    try:
        spec = importlib.util.find_spec(name)
        if spec:
            GENAI_MODULE = importlib.import_module(name)
            break
    except Exception:
        pass

# ------------------------------
# Environment
# ------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, ".env"))

GEMINI_API_KEYS = [
    os.getenv("GEMINI_API_KEY", ""),
    os.getenv("GEMINI_API_KEY_2", ""),
    os.getenv("GEMINI_API_KEY_3", ""),
]
# Filter out empty keys
GEMINI_API_KEYS = [k for k in GEMINI_API_KEYS if k]
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

_CACHE_FILE_ENV = os.getenv("SENTIQ_CACHE_FILE", "sentiq_cache.db")
CACHE_FILE = _CACHE_FILE_ENV if os.path.isabs(_CACHE_FILE_ENV) else os.path.join(BASE_DIR, _CACHE_FILE_ENV)
RPM = int(os.getenv("SENTIQ_RPM", "120"))

# ------------------------------
# Logger
# ------------------------------
logger = logging.getLogger("sentiq.llm")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

# ------------------------------
# Rate Limiter
# ------------------------------
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

# ------------------------------
# Cache helpers
# ------------------------------
# PRIVACY NOTE: Cache key includes the full prompt content, which contains
# user-specific timeline events. Since different users have different events
# in their prompts, cache entries are naturally user-isolated.
# The cache key is: sha256(task|model|prompt), so two users with different
# timeline data will NEVER share a cache entry.
# If user_id is provided, it is also included in the key for extra safety.
def _cache_key(prompt: str, task: str, model: str, user_id: str = ""):
    h = hashlib.sha256()
    h.update(f"{task}|{model}|{user_id}|{prompt}".encode())
    return h.hexdigest()

# ------------------------------
# Task policies
# ------------------------------
# Load canonical task names from shared registry (single source of truth).
# Both Python (llm_adapter.py) and TypeScript (PromptBuilders.ts) consume this file.
_REGISTRY_PATH = os.path.join(BASE_DIR, "task_registry.json")
try:
    with open(_REGISTRY_PATH, "r", encoding="utf-8") as _f:
        _registry = json.load(_f)
    STRICT_JSON_TASKS = set(_registry.get("strict_json_tasks", []))
except Exception as _e:
    logger.error("Failed to load task_registry.json: %s — falling back to empty set.", _e)
    STRICT_JSON_TASKS = set()

# ------------------------------
# Simulation (safe dev mode)
# ------------------------------
def simulated_response(prompt: str, task: str) -> str:
    if task in STRICT_JSON_TASKS:
        return '{"status":"simulated","task":"' + task + '"}'
    return "SIMULATED RESPONSE"

# ------------------------------
# Gemini invocation (supports key rotation)
# ------------------------------
def _call_gemini(prompt: str, api_key: str, model: Optional[str] = None) -> str:
    """Call Gemini with a specific API key."""
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

# ------------------------------
# Router
# ------------------------------
def call_llm_router(
    prompt: str,
    task: str = "general",
    use_simulation: bool = False,
    prefer: Optional[str] = None,
    model_override: Optional[str] = None,
    user_id: Optional[str] = None
) -> str:

    if use_simulation:
        return simulated_response(prompt, task)

    if not GEMINI_API_KEYS:
        logger.error("No Gemini API keys configured")
        return json.dumps({"error": "no_api_keys", "detail": "No GEMINI_API_KEY values found in environment"})

    model = model_override or GEMINI_MODEL
    key = _cache_key(prompt, task, model, user_id or "")

    # Cache
    try:
        with shelve.open(CACHE_FILE) as db:
            if key in db:
                return db[key]
    except Exception:
        pass

    # Enforce JSON if needed
    if task in STRICT_JSON_TASKS:
        prompt = (
            "SYSTEM: Respond ONLY with valid JSON. "
            "No markdown. No explanations.\n\n" + prompt
        )

    # Rotate through all available Gemini API keys
    last_error = None

    for idx, api_key in enumerate(GEMINI_API_KEYS, 1):
        try:
            result = _call_gemini(prompt, api_key, model_override)

            with shelve.open(CACHE_FILE) as db:
                db[key] = result
            logger.info("Gemini key #%d succeeded for task=%s", idx, task)
            return result

        except Exception as e:
            last_error = e
            logger.warning("Gemini key #%d failed: %s", idx, e)

    logger.error("All %d Gemini keys failed: %s", len(GEMINI_API_KEYS), last_error)
    return json.dumps({"error": "all_providers_failed", "detail": str(last_error)})

# ------------------------------
# Backward-compatible API
# ------------------------------
def call_llm(
    prompt: str,
    category: str = "general",
    use_simulation: bool = False,
    model_override: Optional[str] = None
) -> str:
    return call_llm_router(
        prompt=prompt,
        task=category,
        use_simulation=use_simulation,
        model_override=model_override
    )
