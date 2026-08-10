"""LLM translation proxy.

Speaks the OpenAI-compatible chat/completions protocol, so it works with:
  - OpenAI, DeepSeek, Moonshot, Zhipu, Qwen (DashScope compatible-mode), ...
  - Local models via Ollama (http://localhost:11434/v1) or vLLM (OpenAI server).
  - Any future fine-tuned small model you serve with an OpenAI-compatible endpoint.
"""
import asyncio
import json
import logging

import httpx

from config import load_config

log = logging.getLogger("llm")

SYSTEM_TPL = """你是一位资深的中英技术文档翻译专家。请将用户提供的英文文本翻译成{target_lang}。

要求：
1. 忠实原文，译文流畅自然，符合{target_lang}表达习惯；
2. 保留代码、命令、变量名、函数名和专有名词，可适当在括号中附英文原文；
3. 保持 Markdown 格式（如列表、代码块、粗体等）；
4. 只输出译文，不要输出任何解释或前言。
"""

SYSTEM_EXPLAIN_TPL = SYSTEM_TPL + """

额外要求：译文之后另起一段，用简明扼要的方式解释这段文字的关键术语、技术背景和难点，方便英语非母语读者理解。
"""


def _payload(text, cfg):
    style = cfg.get("style", "fluent")
    system = (SYSTEM_EXPLAIN_TPL if style == "explain" else SYSTEM_TPL).format(
        target_lang=cfg.get("target_lang", "中文")
    )
    return {
        "model": cfg["llm"]["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        "stream": True,
        "temperature": 0.3,
    }


async def stream_translate(text: str, cfg: dict | None = None):
    """Async generator yielding SSE lines. Raises LLMConfigError when not configured."""
    cfg = cfg or load_config()
    base_url = (cfg["llm"].get("base_url") or "").rstrip("/")
    api_key = cfg["llm"].get("api_key") or ""
    model = cfg["llm"].get("model") or ""
    if not base_url or not model:
        raise LLMConfigError("未配置 LLM（Base URL / Model），请在「设置」中配置，或设置 LLM_API_KEY / LLM_MODEL 环境变量。")
    if base_url.lower().startswith("http://localhost") and not api_key:
        api_key = "ollama"  # Ollama doesn't require a key

    url = f"{base_url}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
        async with client.stream("POST", url, headers=headers, json=_payload(text, cfg)) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise LLMRequestError(resp.status_code, body)
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    yield data  # forward [DONE]
                    continue
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (obj.get("choices") or [{}])[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield content


async def test_connection(cfg: dict) -> dict:
    """Minimal non-stream request to verify the LLM endpoint works."""
    cfg = cfg or load_config()
    base_url = (cfg["llm"].get("base_url") or "").rstrip("/")
    api_key = cfg["llm"].get("api_key") or ""
    model = cfg["llm"].get("model") or ""
    if not base_url or not model:
        return {"ok": False, "message": "未配置 Base URL 或 Model"}
    if base_url.lower().startswith("http://localhost") and not api_key:
        api_key = "ollama"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                if api_key else {"Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 5,
                    "stream": False,
                },
            )
        if resp.status_code == 200:
            return {"ok": True, "message": f"连接成功，模型响应正常（{model}）"}
        return {"ok": False, "message": f"HTTP {resp.status_code}: {resp.text[:200]}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"连接失败: {e}"}


class LLMConfigError(Exception):
    pass


class LLMRequestError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        super().__init__(f"LLM 请求失败 HTTP {status}: {body}")
