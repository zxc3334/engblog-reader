"""EngBlog Reader — local full-stack English tech-blog reading assistant.

Run:  uvicorn server.main:app --host 0.0.0.0 --port 8000
  or:  python server/main.py
"""
import json
import logging
import os
import re

import httpx
import trafilatura
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database as db
import llm
from config import load_config, save_config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(ROOT, "static")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("main")

db.init_db()
# 数据有变化时自动备份到 data/backup/
try:
    b = db.backup_if_changed()
    if b:
        log.info("已自动备份数据库 → %s", b)
except Exception:  # noqa: BLE001
    log.warning("自动备份失败（不影响运行）", exc_info=True)

app = FastAPI(title="EngBlog Reader")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------- models ----------------
class ArticleIn(BaseModel):
    title: str = ""
    content: str
    source_url: str = ""


class ProgressIn(BaseModel):
    scroll: float


class HighlightIn(BaseModel):
    text: str
    start_offset: int
    end_offset: int
    note: str = ""
    color: str = ""


class NoteIn(BaseModel):
    note: str


class TranslateIn(BaseModel):
    text: str
    style: str | None = None
    target_lang: str | None = None


class WordIn(BaseModel):
    word: str
    context: str = ""


class FetchIn(BaseModel):
    url: str


class TtsIn(BaseModel):
    text: str
    voice: str | None = None
    rate: float | None = None


class ConfigIn(BaseModel):
    llm: dict | None = None
    target_lang: str | None = None
    style: str | None = None
    tts_rate: float | None = None
    tts_voice: str | None = None
    tts_engine: str | None = None
    tts_voice_edge: str | None = None


class ExportData(BaseModel):
    articles: list = []


# ---------------- articles ----------------
@app.get("/api/articles")
def api_list_articles():
    return db.list_articles()


@app.post("/api/articles")
def api_create_article(a: ArticleIn):
    title = (a.title or "").strip() or _auto_title(a.content)
    aid = db.create_article(title, a.content, a.source_url.strip())
    return db.get_article(aid)


@app.get("/api/articles/{aid}")
def api_get_article(aid: int):
    art = db.get_article(aid)
    if not art:
        raise HTTPException(404, "文章不存在")
    art["highlights"] = db.list_highlights(aid)
    return art


@app.put("/api/articles/{aid}")
def api_update_article(aid: int, a: ArticleIn):
    if not db.get_article(aid):
        raise HTTPException(404, "文章不存在")
    db.update_article(aid, title=a.title or None, content=a.content or None,
                      source_url=a.source_url or None)
    return db.get_article(aid)


@app.put("/api/articles/{aid}/progress")
def api_save_progress(aid: int, p: ProgressIn):
    db.save_progress(aid, max(0.0, min(1.0, p.scroll)))
    return {"ok": True}


@app.delete("/api/articles/{aid}")
def api_delete_article(aid: int):
    db.delete_article(aid)
    return {"ok": True}


# ---------------- highlights ----------------
@app.post("/api/articles/{aid}/highlights")
def api_add_highlight(aid: int, h: HighlightIn):
    if not db.get_article(aid):
        raise HTTPException(404, "文章不存在")
    hid = db.add_highlight(aid, h.text, h.start_offset, h.end_offset, h.note, h.color)
    return {"id": hid}


@app.put("/api/highlights/{hid}")
def api_update_highlight(hid: int, n: NoteIn):
    db.update_highlight_note(hid, n.note)
    return {"ok": True}


@app.delete("/api/highlights/{hid}")
def api_delete_highlight(hid: int):
    db.delete_highlight(hid)
    return {"ok": True}


# ---------------- url 抓取 ----------------
def _download_html(url: str) -> bytes:
    """浏览器 UA 下载 HTML（trafilatura 默认 UA 易被拒、超时偏短）"""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    with httpx.Client(
        timeout=httpx.Timeout(30.0, connect=15.0),
        follow_redirects=True,
        headers=headers,
    ) as client:
        resp = client.get(url)
        resp.raise_for_status()
        if len(resp.content) > 20 * 1024 * 1024:
            raise HTTPException(422, "页面体积过大（>20MB），放弃下载")
        return resp.content


def _clean_title(raw: str, url: str) -> str:
    """去网站名后缀（如 ' - SiteName' / ' | Site'）和多余空白"""
    t = (raw or "").strip()
    if not t:
        return ""
    m = re.match(r"https?://([^/]+)", url)
    domain = re.sub(r"^www\.", "", m.group(1).lower()) if m else ""
    if domain:
        # 同时尝试完整域名和主域名名（如 overreacted.io → overreacted）
        for d in {domain, domain.split(".")[0]}:
            if d:
                t = re.sub(r"\s*[\-–—|·]\s*" + re.escape(d) + r"\s*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*[\-–—|·]\s*(medium\.com|github\.io|dev\.to|substack\.com)$", "", t, flags=re.IGNORECASE)
    return t[:120].strip()


@app.post("/api/fetch")
def api_fetch(f: FetchIn):
    url = f.url.strip()
    if not url:
        raise HTTPException(400, "URL 不能为空")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL 格式不正确，需以 http(s):// 开头")
    try:
        downloaded = _download_html(url)
    except httpx.TimeoutException:
        raise HTTPException(422, "下载超时：页面较大或网络较慢，请重试或改用手动粘贴")
    except httpx.HTTPStatusError as e:
        raise HTTPException(422, f"页面返回错误状态码 {e.response.status_code}（链接可能已失效）")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("download failed")
        raise HTTPException(500, f"下载失败：{e}")
    try:
        content = trafilatura.extract(
            downloaded,
            output_format="markdown",
            include_links=False,
            include_images=False,
            url=url,
        )
        if not content:
            raise HTTPException(422, "未能提取到正文：该页面可能是 JS 动态渲染（如部分 SPA 站点），请改用「手动粘贴 Markdown」")
        meta = trafilatura.extract_metadata(downloaded)
        raw_title = (meta.title if meta else "") or ""
        title = _clean_title(raw_title, url) or _auto_title(content)
        return {"title": title, "content": content, "source_url": url}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("fetch failed")
        raise HTTPException(500, f"抓取失败：{e}")


# ---------------- tts ----------------
try:
    import edge_tts
    EDGE_TTS_AVAILABLE = True
except ImportError:
    edge_tts = None
    EDGE_TTS_AVAILABLE = False

EDGE_VOICES = [
    "en-US-ChristopherNeural", "en-US-GuyNeural", "en-US-AndrewNeural",
    "en-US-BrianNeural", "en-US-EricNeural", "en-US-RogerNeural",
    "en-US-SteffanNeural", "en-US-AriaNeural", "en-US-JennyNeural",
    "en-US-MichelleNeural", "en-GB-RyanNeural", "en-GB-ThomasNeural",
]


@app.post("/api/tts")
async def api_tts(t: TtsIn):
    """Edge 神经语音：返回 mp3 音频。音色需为 EDGE_VOICES 中列出的 id。"""
    text = t.text.strip()
    if not text:
        raise HTTPException(400, "朗读内容为空")
    if not EDGE_TTS_AVAILABLE:
        raise HTTPException(501, "未安装 edge-tts，请执行 .venv/bin/pip install edge-tts")
    voice = t.voice or "en-US-ChristopherNeural"
    if voice not in EDGE_VOICES:
        raise HTTPException(400, f"不支持的音色: {voice}")
    rate_pct = int(round((t.rate - 1.0) * 100)) if t.rate else 0
    rate_str = f"{rate_pct:+d}%"
    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate_str)
        audio = bytearray()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
        if not audio:
            raise HTTPException(502, "TTS 服务无响应（无法连接微软服务器，请检查网络）")
        return Response(content=bytes(audio), media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("tts failed")
        raise HTTPException(502, f"Edge TTS 生成失败（需联网）：{e}")


# ---------------- 数据备份 / 迁移 ----------------
@app.get("/api/export")
def api_export():
    """导出全部数据（JSON 备份）"""
    return db.export_all()


@app.post("/api/import")
def api_import(data: ExportData):
    """从备份文件恢复数据"""
    n_art, n_hl = db.import_all(data.model_dump())
    if n_art == 0:
        raise HTTPException(422, "备份文件里没有可导入的文章")
    return {"articles": n_art, "highlights": n_hl}


# ---------------- llm / config ----------------
def _sse_response(agen, err_prefix="出错"):
    """把 LLM 流式异步生成器包装成 SSE StreamingResponse（统一错误处理）。"""

    async def gen():
        try:
            async for chunk in agen:
                if chunk == "[DONE]":
                    yield "data: [DONE]\n\n"
                else:
                    yield f"data: {json.dumps({'delta': chunk}, ensure_ascii=False)}\n\n"
        except llm.LLMConfigError as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except llm.LLMRequestError as e:
            yield f"data: {json.dumps({'error': f'HTTP {e.status}: {e.body}'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:  # noqa: BLE001
            log.exception("%s failed", err_prefix)
            yield f"data: {json.dumps({'error': f'{err_prefix}: {e}'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/translate")
async def api_translate(t: TranslateIn):
    """Streaming SSE proxy to the configured LLM."""
    cfg = load_config()
    if t.style:
        cfg["style"] = t.style
    if t.target_lang:
        cfg["target_lang"] = t.target_lang
    text = t.text.strip()
    if not text:
        raise HTTPException(400, "翻译内容为空")
    return _sse_response(llm.stream_translate(text, cfg), err_prefix="翻译出错")


@app.post("/api/word")
async def api_word(w: WordIn):
    """单词语义：上下文推断含义 + 常规含义（流式 SSE）。"""
    word = w.word.strip()
    if not word:
        raise HTTPException(400, "单词不能为空")
    return _sse_response(
        llm.stream_word_meaning(word, (w.context or "").strip(), load_config()),
        err_prefix="查询词义出错",
    )


@app.post("/api/llm/test")
async def api_test_llm(cfg: ConfigIn | None = None):
    merged = save_config(cfg.model_dump(exclude_none=True)) if cfg else load_config()
    return await llm.test_connection(merged)


@app.get("/api/config")
def api_get_config():
    cfg = load_config()
    return {
        "llm": {"base_url": cfg["llm"]["base_url"], "model": cfg["llm"]["model"]},
        "api_key_set": bool(cfg["llm"].get("api_key")),
        "target_lang": cfg["target_lang"],
        "style": cfg["style"],
        "tts_rate": cfg["tts_rate"],
        "tts_voice": cfg["tts_voice"],
        "tts_engine": cfg.get("tts_engine", "edge"),
        "tts_voice_edge": cfg.get("tts_voice_edge", "en-US-ChristopherNeural"),
        "data_path": db.DB_PATH,
        "data_size": os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0,
    }


@app.put("/api/config")
def api_put_config(cfg: ConfigIn):
    # never leak the key back; allow empty string to clear it
    save_config(cfg.model_dump(exclude_none=True))
    return api_get_config()


# ---------------- static ----------------
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _auto_title(content: str) -> str:
    for line in content.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()[:80]
    for line in content.splitlines():
        s = line.strip()
        if s and not s.startswith(("#", ">", "-", "*", "```", "![", "<")):
            return s[:80]
    return "未命名文章"


if __name__ == "__main__":
    import uvicorn

    db.init_db()
    # 0.0.0.0 允许手机等局域网设备访问；如需更安全可改为 127.0.0.1
    uvicorn.run(app, host="0.0.0.0", port=8000)
