#!/usr/bin/env python3
"""
ARES Bio.OS — HTTP API Gateway for Cloud Run

Lightweight FastAPI wrapper that exposes the Hermes Agent as an HTTP API.
This is the Cloud Run entrypoint — NOT the Hermes CLI gateway (which is for
messaging platforms like Telegram/Discord).

Endpoints:
  POST /v1/chat        — Send a message to ARES (with MCP tool access)
  POST /v1/chat/stream — SSE stream response
  GET  /health         — Health check
  GET  /v1/tools       — List available MCP tools
"""

import os
import json
import asyncio
import logging
from typing import Optional
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Hermes Agent core imports ────────────────────────────────────────────
try:
    from run_agent import (
        run_agent_turn,
        build_system_prompt,
        get_model_config,
    )
    HERMES_AVAILABLE = True
except ImportError:
    HERMES_AVAILABLE = False
    logging.warning("Hermes agent core not available — running in stub mode")

# ── Config ───────────────────────────────────────────────────────────────
MCP_SERVER_URL = os.environ.get("ARES_MCP_SERVER_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
PORT = int(os.environ.get("PORT", "8080"))
MODEL = os.environ.get("HERMES_MODEL", "nousresearch/hermes-4-405b")

logger = logging.getLogger("ares-gateway")
logging.basicConfig(level=logging.INFO)

# ── MCP Client ───────────────────────────────────────────────────────────

class AresMCPClient:
    """Lightweight MCP client that calls the ARES MCP Server Edge Function."""

    def __init__(self, base_url: str):
        self.base_url = base_url
        self.client = httpx.AsyncClient(timeout=30)
        self._tools_cache = None

    async def initialize(self, jwt: str) -> dict:
        """Initialize MCP session and cache tool list."""
        resp = await self._rpc("initialize", {}, jwt)
        tools_resp = await self._rpc("tools/list", {}, jwt)
        self._tools_cache = tools_resp.get("tools", [])
        return resp

    async def list_tools(self, jwt: str) -> list:
        """Return cached tools or fetch fresh."""
        if self._tools_cache is None:
            await self.initialize(jwt)
        return self._tools_cache or []

    async def call_tool(self, name: str, arguments: dict, jwt: str) -> dict:
        """Call an MCP tool and return result."""
        return await self._rpc("tools/call", {
            "name": name,
            "arguments": arguments,
        }, jwt)

    async def _rpc(self, method: str, params: dict, jwt: str) -> dict:
        """Send JSON-RPC 2.0 request to MCP server."""
        try:
            resp = await self.client.post(
                self.base_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": params,
                },
                headers={
                    "Authorization": f"Bearer {jwt}",
                    "Content-Type": "application/json",
                },
            )
            data = resp.json()
            if "error" in data:
                logger.error(f"MCP error: {data['error']}")
                return {"error": data["error"]}
            return data.get("result", {})
        except Exception as e:
            logger.error(f"MCP call failed: {e}")
            return {"error": str(e)}

    async def close(self):
        await self.client.aclose()


mcp_client = AresMCPClient(MCP_SERVER_URL) if MCP_SERVER_URL else None

# ── Request/Response Models ──────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str = Field(description="Message role: system, user, assistant")
    content: str = Field(description="Message content")

class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(description="Conversation messages")
    user_jwt: str = Field(description="Supabase JWT for user auth + MCP data access")
    model: Optional[str] = Field(default=None, description="Override model")
    temperature: Optional[float] = Field(default=0.7)
    max_tokens: Optional[int] = Field(default=4096)
    stream: Optional[bool] = Field(default=False)
    use_mcp: Optional[bool] = Field(default=True, description="Enable MCP tool access")

# ── App ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"🚀 ARES Hermes Gateway starting on port {PORT}")
    logger.info(f"   Model: {MODEL}")
    logger.info(f"   MCP Server: {MCP_SERVER_URL or 'NOT CONFIGURED'}")
    logger.info(f"   Hermes core: {'available' if HERMES_AVAILABLE else 'STUB MODE'}")
    yield
    if mcp_client:
        await mcp_client.close()
    logger.info("Gateway shutdown complete")

app = FastAPI(
    title="ARES Bio.OS — Hermes Agent Gateway",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Endpoints ────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "ares-hermes-agent",
        "model": MODEL,
        "mcp_configured": bool(MCP_SERVER_URL),
        "hermes_available": HERMES_AVAILABLE,
    }

@app.get("/v1/tools")
async def list_tools(authorization: str = Header(default="")):
    """List available MCP tools."""
    if not mcp_client:
        return {"tools": [], "error": "MCP not configured"}
    jwt = authorization.replace("Bearer ", "")
    tools = await mcp_client.list_tools(jwt)
    return {"tools": tools}

@app.post("/v1/chat")
async def chat(req: ChatRequest):
    """Send a chat message to ARES Hermes Agent."""
    model = req.model or MODEL

    # Build enriched system prompt with MCP context
    system_context = ""
    if req.use_mcp and mcp_client:
        try:
            # Auto-fetch fact snapshot for context
            snapshot = await mcp_client.call_tool("get_fact_snapshot", {}, req.user_jwt)
            if snapshot and "error" not in snapshot:
                system_context = f"\n\n## Current User Data Inventory\n```json\n{json.dumps(snapshot, indent=2, default=str)[:4000]}\n```"
        except Exception as e:
            logger.warning(f"Failed to fetch fact snapshot: {e}")

    # Build messages for LLM
    messages = []
    for msg in req.messages:
        if msg.role == "system":
            messages.append({"role": "system", "content": msg.content + system_context})
        else:
            messages.append({"role": msg.role, "content": msg.content})

    # If no system message, prepend ARES system prompt
    if not any(m["role"] == "system" for m in messages):
        soul_path = os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "SOUL.md")
        soul = ""
        if os.path.exists(soul_path):
            with open(soul_path) as f:
                soul = f.read()
        messages.insert(0, {"role": "system", "content": soul + system_context})

    # Call LLM via OpenRouter (OpenAI-compatible API)
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                    "stream": False,
                },
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://app.bio-os.io",
                    "X-Title": "ARES Bio.OS",
                },
            )
            data = resp.json()
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=data)

            choice = data["choices"][0]
            return {
                "id": data.get("id"),
                "content": choice["message"]["content"],
                "model": data.get("model", model),
                "usage": data.get("usage"),
                "provider": "hermes_agent",
                "mcp_enriched": bool(system_context),
            }
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="LLM request timed out")

@app.post("/v1/chat/stream")
async def chat_stream(req: ChatRequest):
    """Stream a chat response from ARES Hermes Agent via SSE."""
    model = req.model or MODEL

    # Build enriched context (same as non-streaming)
    system_context = ""
    if req.use_mcp and mcp_client:
        try:
            snapshot = await mcp_client.call_tool("get_fact_snapshot", {}, req.user_jwt)
            if snapshot and "error" not in snapshot:
                system_context = f"\n\n## Current User Data Inventory\n```json\n{json.dumps(snapshot, indent=2, default=str)[:4000]}\n```"
        except Exception:
            pass

    messages = []
    for msg in req.messages:
        if msg.role == "system":
            messages.append({"role": "system", "content": msg.content + system_context})
        else:
            messages.append({"role": msg.role, "content": msg.content})

    if not any(m["role"] == "system" for m in messages):
        soul_path = os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "SOUL.md")
        soul = ""
        if os.path.exists(soul_path):
            with open(soul_path) as f:
                soul = f.read()
        messages.insert(0, {"role": "system", "content": soul + system_context})

    async def event_stream():
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                "https://openrouter.ai/api/v1/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                    "stream": True,
                },
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://app.bio-os.io",
                    "X-Title": "ARES Bio.OS",
                },
            ) as resp:
                if resp.status_code != 200:
                    err = await resp.aread()
                    yield f"data: {{\"error\": \"{err.decode()[:500]}\"}}"
                    return
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        yield f"{line}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
