"""SQLite persistence: articles (with reading progress) and highlights (notes)."""
import os
import sqlite3
import threading
import time

from config import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "blog.db")
_lock = threading.Lock()
_conn = None


def _get_conn():
    global _conn
    if _conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


def init_db():
    conn = _get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS articles (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            source_url TEXT DEFAULT '',
            content    TEXT NOT NULL,
            created_at REAL,
            updated_at REAL,
            scroll     REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS highlights (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id   INTEGER NOT NULL,
            text         TEXT,
            note         TEXT DEFAULT '',
            start_offset INTEGER,
            end_offset   INTEGER,
            color        TEXT DEFAULT '',
            kind         TEXT DEFAULT 'hl',
            word         TEXT DEFAULT '',
            context      TEXT DEFAULT '',
            content      TEXT DEFAULT '',
            created_at   REAL
        );
        CREATE INDEX IF NOT EXISTS idx_hl_article ON highlights(article_id);
        """
    )
    # 迁移：老库补齐新列（kind/word/context/content），已存在则跳过
    existing = {r[1] for r in conn.execute("PRAGMA table_info(highlights)")}
    for col, ddl in {
        "kind": "ALTER TABLE highlights ADD COLUMN kind TEXT DEFAULT 'hl'",
        "word": "ALTER TABLE highlights ADD COLUMN word TEXT DEFAULT ''",
        "context": "ALTER TABLE highlights ADD COLUMN context TEXT DEFAULT ''",
        "content": "ALTER TABLE highlights ADD COLUMN content TEXT DEFAULT ''",
    }.items():
        if col not in existing:
            conn.execute(ddl)
    conn.commit()


def now():
    return time.time()


# ---------------- articles ----------------
def create_article(title, content, source_url=""):
    with _lock:
        cur = _get_conn().execute(
            "INSERT INTO articles (title, source_url, content, created_at, updated_at, scroll) VALUES (?,?,?,?,?,0)",
            (title, source_url, content, now(), now()),
        )
        _get_conn().commit()
        return cur.lastrowid


def update_article(id_, title=None, content=None, source_url=None):
    fields, vals = [], []
    if title is not None:
        fields.append("title=?"); vals.append(title)
    if content is not None:
        fields.append("content=?"); vals.append(content)
    if source_url is not None:
        fields.append("source_url=?"); vals.append(source_url)
    fields.append("updated_at=?"); vals.append(now())
    vals.append(id_)
    with _lock:
        _get_conn().execute(f"UPDATE articles SET {', '.join(fields)} WHERE id=?", vals)
        _get_conn().commit()


def save_progress(id_, scroll):
    with _lock:
        _get_conn().execute(
            "UPDATE articles SET scroll=?, updated_at=? WHERE id=?", (scroll, now(), id_)
        )
        _get_conn().commit()


def get_article(id_):
    row = _get_conn().execute("SELECT * FROM articles WHERE id=?", (id_,)).fetchone()
    return dict(row) if row else None


def list_articles():
    rows = _get_conn().execute(
        "SELECT id, title, source_url, created_at, updated_at, scroll, "
        "LENGTH(content) AS size FROM articles ORDER BY updated_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def delete_article(id_):
    with _lock:
        _get_conn().execute("DELETE FROM highlights WHERE article_id=?", (id_,))
        _get_conn().execute("DELETE FROM articles WHERE id=?", (id_,))
        _get_conn().commit()


# ---------------- 备份 / 迁移 ----------------
def export_all() -> dict:
    """导出全部文章与划线（JSON 备份/迁移用）"""
    out = {"articles": []}
    for a in list_articles():
        art = get_article(a["id"])
        art["highlights"] = list_highlights(a["id"])
        out["articles"].append(art)
    return out


def import_all(payload: dict) -> tuple:
    """从备份恢复：返回 (文章数, 划线数)"""
    n_art, n_hl = 0, 0
    for a in payload.get("articles") or []:
        if not a.get("content"):
            continue
        aid = create_article(
            (a.get("title") or "").strip() or "未命名文章",
            a["content"],
            (a.get("source_url") or "").strip(),
        )
        scroll = a.get("scroll") or 0
        save_progress(aid, min(1.0, max(0.0, float(scroll))))
        for h in a.get("highlights") or []:
            if h.get("text") and h.get("start_offset") is not None and h.get("end_offset") is not None:
                add_highlight(aid, h["text"], h["start_offset"], h["end_offset"],
                              h.get("note") or "", h.get("color") or "",
                              h.get("kind") or "hl", h.get("word") or "",
                              h.get("context") or "", h.get("content") or "")
                n_hl += 1
        n_art += 1
    return n_art, n_hl


def backup_if_changed() -> str | None:
    """数据有变化时自动备份到 data/backup/，返回备份文件名或 None"""
    if not os.path.exists(DB_PATH):
        return None
    backup_dir = os.path.join(DATA_DIR, "backup")
    os.makedirs(backup_dir, exist_ok=True)
    db_mtime = os.path.getmtime(DB_PATH)
    existing = sorted(f for f in os.listdir(backup_dir) if f.startswith("blog-") and f.endswith(".db"))
    if existing:
        latest = os.path.join(backup_dir, existing[-1])
        if os.path.getmtime(latest) >= db_mtime:
            return None  # 数据没有新变化
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"blog-{stamp}.db"
    with _lock:
        conn = _get_conn()
        conn.execute("VACUUM INTO ?", (os.path.join(backup_dir, name),))
        conn.commit()
    # 只保留最近 20 份
    all_baks = sorted(f for f in os.listdir(backup_dir) if f.startswith("blog-") and f.endswith(".db"))
    for f in all_baks[:-20]:
        os.remove(os.path.join(backup_dir, f))
    return name


# ---------------- highlights ----------------
def add_highlight(article_id, text, start_offset, end_offset, note="", color="",
                  kind="hl", word="", context="", content=""):
    with _lock:
        cur = _get_conn().execute(
            "INSERT INTO highlights (article_id, text, note, start_offset, end_offset, color, "
            "kind, word, context, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (article_id, text, note, start_offset, end_offset, color, kind, word, context, content, now()),
        )
        _get_conn().commit()
        return cur.lastrowid


def update_highlight_note(hid, note):
    with _lock:
        _get_conn().execute("UPDATE highlights SET note=? WHERE id=?", (note, hid))
        _get_conn().commit()


def list_highlights(article_id):
    rows = _get_conn().execute(
        "SELECT * FROM highlights WHERE article_id=? ORDER BY start_offset", (article_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def delete_highlight(hid):
    with _lock:
        _get_conn().execute("DELETE FROM highlights WHERE id=?", (hid,))
        _get_conn().commit()
