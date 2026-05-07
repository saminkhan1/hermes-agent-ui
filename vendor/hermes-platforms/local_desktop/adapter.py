"""Local desktop platform adapter for Hermes Agent.

The adapter exposes a local authenticated HTTP gateway for desktop clients:

    GET  /health
    GET  /events
    POST /messages

Inbound messages are converted to normal MessageEvent instances and dispatched
through BasePlatformAdapter.handle_message(). Outbound delivery appends
replayable events to a SQLite outbox and streams them over SSE.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
import uuid
from typing import Any, Dict, Optional

try:
    from aiohttp import web

    AIOHTTP_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised in envs without aiohttp
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
)
from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_USER_ID = "local"
DEFAULT_RETENTION_DAYS = 7
MAX_REQUEST_BYTES = 1_048_576


def _env_text(name: str) -> str:
    return os.getenv(name, "").strip()


def _gateway_key() -> str:
    return _env_text("LOCAL_DESKTOP_GATEWAY_KEY")


def check_requirements() -> bool:
    """Return whether the local desktop gateway can start."""
    return AIOHTTP_AVAILABLE and bool(_gateway_key())


def _cfg_extra(config: PlatformConfig) -> Dict[str, Any]:
    extra = getattr(config, "extra", {}) or {}
    return extra if isinstance(extra, dict) else {}


def validate_config(config: PlatformConfig) -> bool:
    """Validate configuration enough for gateway startup menus/status."""
    extra = _cfg_extra(config)
    port = _env_text("LOCAL_DESKTOP_PORT") or extra.get("port", DEFAULT_PORT)
    try:
        port_int = int(port)
    except (TypeError, ValueError):
        return False
    return bool(_gateway_key()) and 0 < port_int < 65536


def is_connected(config: PlatformConfig) -> bool:
    return validate_config(config)


class LocalDesktopAdapter(BasePlatformAdapter):
    """Loopback HTTP/SSE gateway adapter for native desktop clients."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("local_desktop"))
        extra = _cfg_extra(config)

        self.host = _env_text("LOCAL_DESKTOP_HOST") or str(extra.get("host") or DEFAULT_HOST)
        self.port = int(_env_text("LOCAL_DESKTOP_PORT") or extra.get("port") or DEFAULT_PORT)
        self.user_id = str(extra.get("user_id") or DEFAULT_USER_ID)
        self.retention_days = int(extra.get("outbox_retention_days") or DEFAULT_RETENTION_DAYS)
        self.gateway_key = _gateway_key()

        home = get_hermes_home()
        self._data_dir = home / "local_desktop"
        self._db_path = self._data_dir / "outbox.sqlite"
        self._runner: Optional["web.AppRunner"] = None
        self._site = None
        self._db_lock = asyncio.Lock()
        self._subscribers: set[asyncio.Queue] = set()

    @property
    def name(self) -> str:
        return "Local Desktop"

    async def connect(self) -> bool:
        if not AIOHTTP_AVAILABLE or web is None:
            logger.warning("[local_desktop] aiohttp is not installed")
            return False
        if not self.gateway_key:
            logger.warning("[local_desktop] LOCAL_DESKTOP_GATEWAY_KEY is required")
            return False

        await self._init_db()
        await self._prune_old_events()

        app = web.Application(client_max_size=MAX_REQUEST_BYTES)
        app.router.add_get("/health", self._handle_health)
        app.router.add_get("/events", self._handle_events)
        app.router.add_post("/messages", self._handle_messages)

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()
        self._mark_connected()
        logger.info("[local_desktop] Listening on %s:%d", self.host, self.port)
        return True

    async def disconnect(self) -> None:
        if self._runner:
            await self._runner.cleanup()
            self._runner = None
            self._site = None
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._subscribers.clear()
        self._mark_disconnected()
        logger.info("[local_desktop] Disconnected")

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        message_id = uuid.uuid4().hex
        await self._append_event(
            "message.created",
            conversation_id=chat_id,
            message_id=message_id,
            payload={
                "text": content,
                "reply_to": reply_to,
                "metadata": metadata or {},
            },
        )
        return SendResult(success=True, message_id=message_id)

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        await self._append_event(
            "message.updated",
            conversation_id=chat_id,
            message_id=message_id,
            payload={"text": content, "finalize": bool(finalize)},
        )
        return SendResult(success=True, message_id=message_id)

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        await self._append_event(
            "message.deleted",
            conversation_id=chat_id,
            message_id=message_id,
            payload={},
        )
        return True

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        await self._append_event(
            "typing.started",
            conversation_id=chat_id,
            message_id=None,
            payload={"metadata": metadata or {}},
        )

    async def stop_typing(self, chat_id: str) -> None:
        await self._append_event(
            "typing.stopped",
            conversation_id=chat_id,
            message_id=None,
            payload={"transient": True},
        )

    async def on_processing_start(self, event: MessageEvent) -> None:
        source = event.source
        if source:
            await self._append_event(
                "typing.started",
                conversation_id=source.chat_id,
                message_id=getattr(event, "message_id", None),
                payload={"inbound_message_id": getattr(event, "message_id", None)},
            )

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        source = event.source
        if source:
            await self._append_event(
                "typing.stopped",
                conversation_id=source.chat_id,
                message_id=getattr(event, "message_id", None),
                payload={
                    "inbound_message_id": getattr(event, "message_id", None),
                    "outcome": outcome.value if hasattr(outcome, "value") else str(outcome),
                },
            )

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        return await self._append_attachment(chat_id, "image", image_url, caption, reply_to, metadata)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._append_attachment(chat_id, "image", image_path, caption, reply_to, metadata)

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        meta = dict(metadata or {})
        if file_name:
            meta["file_name"] = file_name
        return await self._append_attachment(chat_id, "document", file_path, caption, reply_to, meta)

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._append_attachment(chat_id, "voice", audio_path, caption, reply_to, metadata)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._append_attachment(chat_id, "video", video_path, caption, reply_to, metadata)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm"}

    async def _append_attachment(
        self,
        chat_id: str,
        kind: str,
        ref: str,
        caption: Optional[str],
        reply_to: Optional[str],
        metadata: Optional[Dict[str, Any]],
    ) -> SendResult:
        message_id = uuid.uuid4().hex
        await self._append_event(
            "attachment.created",
            conversation_id=chat_id,
            message_id=message_id,
            payload={
                "attachment_type": kind,
                "ref": ref,
                "caption": caption,
                "reply_to": reply_to,
                "metadata": metadata or {},
            },
        )
        return SendResult(success=True, message_id=message_id)

    async def _init_db(self) -> None:
        self._data_dir.mkdir(parents=True, exist_ok=True)
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS outbox (
                        seq INTEGER PRIMARY KEY AUTOINCREMENT,
                        type TEXT NOT NULL,
                        conversation_id TEXT NOT NULL,
                        message_id TEXT,
                        payload_json TEXT NOT NULL,
                        created_at REAL NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS inbound_messages (
                        message_id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        request_hash TEXT NOT NULL,
                        accepted_at REAL NOT NULL
                    )
                    """
                )
                conn.commit()

    async def _prune_old_events(self) -> None:
        cutoff = time.time() - max(1, self.retention_days) * 86400
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("DELETE FROM outbox WHERE created_at < ?", (cutoff,))
                conn.execute("DELETE FROM inbound_messages WHERE accepted_at < ?", (cutoff,))
                conn.commit()

    async def _latest_seq(self) -> int:
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                row = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM outbox").fetchone()
                return int(row[0] or 0)

    async def _earliest_seq(self) -> int:
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                row = conn.execute("SELECT COALESCE(MIN(seq), 0) FROM outbox").fetchone()
                return int(row[0] or 0)

    async def _events_after(self, seq: int) -> list[dict]:
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT seq, type, conversation_id, message_id, payload_json, created_at
                    FROM outbox
                    WHERE seq > ?
                    ORDER BY seq ASC
                    """,
                    (seq,),
                ).fetchall()
        return [self._row_to_event(row) for row in rows]

    def _row_to_event(self, row: tuple) -> dict:
        seq, event_type, conversation_id, message_id, payload_json, created_at = row
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            payload = {}
        event = {
            "seq": int(seq),
            "type": event_type,
            "conversation_id": conversation_id,
            "message_id": message_id,
            "created_at": created_at,
        }
        if isinstance(payload, dict):
            event.update(payload)
        return event

    async def _append_event(
        self,
        event_type: str,
        *,
        conversation_id: str,
        message_id: Optional[str],
        payload: Dict[str, Any],
    ) -> dict:
        created_at = time.time()
        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                cur = conn.execute(
                    """
                    INSERT INTO outbox (type, conversation_id, message_id, payload_json, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (event_type, str(conversation_id), message_id, payload_json, created_at),
                )
                conn.commit()
                seq = int(cur.lastrowid)
        event = {
            "seq": seq,
            "type": event_type,
            "conversation_id": str(conversation_id),
            "message_id": message_id,
            "created_at": created_at,
            **payload,
        }
        self._publish(event)
        return event

    def _publish(self, event: dict) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                self._subscribers.discard(queue)
                self._close_overflowed_subscriber(queue)

    def _close_overflowed_subscriber(self, queue: asyncio.Queue) -> None:
        logger.warning("[local_desktop] closing slow SSE subscriber after queue overflow")
        try:
            while True:
                queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:  # pragma: no cover - queue was just drained
            pass

    def _authorized(self, request: "web.Request") -> bool:
        header = request.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        token = header[len(prefix):].strip()
        return bool(token) and hmac.compare_digest(token, self.gateway_key)

    async def _json_error(self, status: int, code: str, message: str) -> "web.Response":
        return web.json_response({"ok": False, "error": code, "message": message}, status=status)

    async def _handle_health(self, request: "web.Request") -> "web.Response":
        return web.json_response(
            {
                "ok": True,
                "status": "ok",
                "platform": "local_desktop",
                "latest_seq": await self._latest_seq(),
            }
        )

    async def _handle_messages(self, request: "web.Request") -> "web.Response":
        if not self._authorized(request):
            return await self._json_error(401, "unauthorized", "Bearer token is required.")
        try:
            body = await request.json()
        except Exception:
            return await self._json_error(400, "invalid_json", "Request body must be JSON.")
        if not isinstance(body, dict):
            return await self._json_error(400, "invalid_request", "Request body must be an object.")

        conversation_id = str(body.get("conversation_id") or "").strip()
        message_id = str(body.get("message_id") or "").strip()
        text = body.get("text")
        chat_name = body.get("chat_name")
        metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}

        if not conversation_id:
            return await self._json_error(400, "missing_conversation_id", "conversation_id is required.")
        if not message_id:
            return await self._json_error(400, "missing_message_id", "message_id is required.")
        if not isinstance(text, str) or not text.strip():
            return await self._json_error(400, "missing_text", "text is required.")

        request_hash = self._inbound_hash(
            {
                "conversation_id": conversation_id,
                "message_id": message_id,
                "text": text,
                "chat_name": chat_name if isinstance(chat_name, str) else None,
                "metadata": metadata,
            }
        )
        accepted = await self._accept_inbound(message_id, conversation_id, request_hash)
        if accepted == "duplicate":
            return web.json_response({"ok": True, "accepted": True, "duplicate": True}, status=202)
        if accepted == "conflict":
            return await self._json_error(409, "duplicate_message_conflict", "message_id was already used with different content.")

        source = self.build_source(
            chat_id=conversation_id,
            chat_type="dm",
            user_id=self.user_id,
            user_name=self.user_id,
            chat_name=chat_name if isinstance(chat_name, str) and chat_name.strip() else None,
            message_id=message_id,
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            raw_message=body,
            message_id=message_id,
            internal=False,
        )
        await self.handle_message(event)
        return web.json_response({"ok": True, "accepted": True, "duplicate": False}, status=202)

    def _inbound_hash(self, payload: dict) -> str:
        data = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(data.encode("utf-8")).hexdigest()

    async def _accept_inbound(self, message_id: str, conversation_id: str, request_hash: str) -> str:
        async with self._db_lock:
            with sqlite3.connect(self._db_path) as conn:
                row = conn.execute(
                    "SELECT request_hash FROM inbound_messages WHERE message_id = ?",
                    (message_id,),
                ).fetchone()
                if row:
                    return "duplicate" if row[0] == request_hash else "conflict"
                conn.execute(
                    """
                    INSERT INTO inbound_messages (message_id, conversation_id, request_hash, accepted_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (message_id, conversation_id, request_hash, time.time()),
                )
                conn.commit()
        return "new"

    async def _handle_events(self, request: "web.Request") -> "web.StreamResponse":
        if not self._authorized(request):
            return await self._json_error(401, "unauthorized", "Bearer token is required.")

        last_seq = self._requested_last_seq(request)
        earliest = await self._earliest_seq()
        if last_seq > 0 and earliest > 0 and last_seq < earliest - 1:
            return await self._json_error(
                409,
                "replay_window_expired",
                "Requested event sequence is outside the retained replay window.",
            )

        response = web.StreamResponse(
            status=200,
            reason="OK",
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)

        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(queue)
        try:
            for event in await self._events_after(last_seq):
                await self._write_sse(response, event)
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    await response.write(b": keepalive\n\n")
                    continue
                if event is None:
                    break
                await self._write_sse(response, event)
        except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
            raise
        except Exception as exc:
            logger.debug("[local_desktop] SSE stream ended: %s", exc)
        finally:
            self._subscribers.discard(queue)
        return response

    def _requested_last_seq(self, request: "web.Request") -> int:
        raw = request.query.get("last_seq")
        if raw is None or raw == "":
            raw = request.headers.get("Last-Event-ID", "")
        try:
            return max(0, int(str(raw).strip() or "0"))
        except (TypeError, ValueError):
            return 0

    async def _write_sse(self, response: "web.StreamResponse", event: dict) -> None:
        data = json.dumps(event, separators=(",", ":"), sort_keys=True)
        frame = f"id: {event['seq']}\nevent: {event['type']}\ndata: {data}\n\n"
        await response.write(frame.encode("utf-8"))


def register(ctx):
    """Plugin entry point called by Hermes plugin discovery."""
    ctx.register_platform(
        name="local_desktop",
        label="Local Desktop",
        adapter_factory=lambda cfg: LocalDesktopAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["LOCAL_DESKTOP_GATEWAY_KEY"],
        install_hint="Set LOCAL_DESKTOP_GATEWAY_KEY to a random secret.",
        allowed_users_env="LOCAL_DESKTOP_ALLOWED_USERS",
        allow_all_env="LOCAL_DESKTOP_ALLOW_ALL_USERS",
        max_message_length=0,
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are chatting through a local desktop client. The client "
            "supports normal text responses and replayable delivery events."
        ),
    )
