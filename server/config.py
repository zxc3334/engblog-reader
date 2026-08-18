"""Server-side configuration management.

Config lives in data/config.json. Any field can be overridden by environment
variables (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) which take precedence.
"""
import json
import os
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 存储目录可通过环境变量 DATA_DIR 覆盖（如挂载 Docker 卷、U 盘等）
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")

_lock = threading.Lock()

DEFAULTS = {
    "llm": {
        "base_url": "",   # e.g. https://api.deepseek.com/v1  or  http://localhost:11434/v1 (Ollama)
        "api_key": "",
        "model": "",
    },
    "target_lang": "中文",
    "style": "fluent",    # fluent | explain
    "tts_rate": 1.0,
    "tts_voice": "",        # 浏览器引擎音色（voiceURI）
    "tts_engine": "edge",   # edge（神经语音）| browser（浏览器内置）
    "tts_voice_edge": "en-US-ChristopherNeural",  # Edge 美音男声
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            for k, v in saved.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception:
            pass
    # environment overrides
    env_map = {"base_url": "LLM_BASE_URL", "api_key": "LLM_API_KEY", "model": "LLM_MODEL"}
    for k, env in env_map.items():
        val = os.environ.get(env)
        if val:
            cfg["llm"][k] = val
    return cfg


def save_config(cfg: dict) -> dict:
    merged = load_config()
    if "llm" in cfg and isinstance(cfg["llm"], dict):
        for k, v in cfg["llm"].items():
            if k == "api_key" and not v:
                continue  # 空字符串 = 用户未填写，保留已存的 key（防止误清空）
            if v is not None:
                merged["llm"][k] = v
    for key in ("target_lang", "style", "tts_rate", "tts_voice", "tts_engine", "tts_voice_edge"):
        if key in cfg:
            merged[key] = cfg[key]
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
    return merged
