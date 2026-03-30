#!/usr/bin/env python3
"""
ARES Bio.OS — HTTP API Gateway for Cloud Run

Lightweight FastAPI wrapper that exposes the Hermes Agent as an HTTP API.
Uses NousResearch Direct API (not OpenRouter) for lowest latency.

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

# ── Config ───────────────────────────────────────────────────────────────
# Primary: NousResearch Direct API (lowest latency, no middleman)
# Fallback: OpenRouter (if NOUS key not available)
NOUS_API_KEY = os.environ.get("NOUS_API_KEY", "")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MCP_SERVER_URL = os.environ.get("ARES_MCP_SERVER_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
PORT = int(os.environ.get("PORT", "8080"))
MODEL = os.environ.get("HERMES_MODEL", "nousresearch/hermes-4-405b")

# API routing: prefer NousResearch direct, fall back to OpenRouter
if NOUS_API_KEY:
    LLM_BASE_URL = "https://inference-api.nousresearch.com/v1"
    LLM_API_KEY = NOUS_API_KEY
    LLM_PROVIDER = "nousresearch_direct"
elif OPENROUTER_API_KEY:
    LLM_BASE_URL = "https://openrouter.ai/api/v1"
    LLM_API_KEY = OPENROUTER_API_KEY
    LLM_PROVIDER = "openrouter"
else:
    LLM_BASE_URL = ""
    LLM_API_KEY = ""
    LLM_PROVIDER = "none"

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
        resp = await self._rpc("initialize", {}, jwt)
        tools_resp = await self._rpc("tools/list", {}, jwt)
        self._tools_cache = tools_resp.get("tools", [])
        return resp

    async def list_tools(self, jwt: str) -> list:
        if self._tools_cache is None:
            await self.initialize(jwt)
        return self._tools_cache or []

    async def call_tool(self, name: str, arguments: dict, jwt: str) -> dict:
        return await self._rpc("tools/call", {
            "name": name,
            "arguments": arguments,
        }, jwt)

    async def _rpc(self, method: str, params: dict, jwt: str) -> dict:
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
    logger.info(f"   LLM Provider: {LLM_PROVIDER}")
    logger.info(f"   LLM Base URL: {LLM_BASE_URL}")
    logger.info(f"   MCP Server: {MCP_SERVER_URL or 'NOT CONFIGURED'}")
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
        "llm_provider": LLM_PROVIDER,
        "mcp_configured": bool(MCP_SERVER_URL),
        "llm_configured": bool(LLM_API_KEY),
    }

@app.get("/v1/tools")
async def list_tools(authorization: str = Header(default="")):
    if not mcp_client:
        return {"tools": [], "error": "MCP not configured"}
    jwt = authorization.replace("Bearer ", "")
    tools = await mcp_client.list_tools(jwt)
    return {"tools": tools}

def _build_llm_headers() -> dict:
    """Build headers for LLM API call based on provider."""
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
    }
    if LLM_PROVIDER == "openrouter":
        headers["HTTP-Referer"] = "https://app.bio-os.io"
        headers["X-Title"] = "ARES Bio.OS"
    return headers

async def _enrich_with_mcp(user_jwt: str) -> str:
    """Fetch fact snapshot from MCP to enrich system context."""
    if not mcp_client:
        return ""
    try:
        snapshot = await mcp_client.call_tool("get_fact_snapshot", {}, user_jwt)
        if snapshot and "error" not in snapshot:
            return f"\n\n## Current User Data Inventory\n```json\n{json.dumps(snapshot, indent=2, default=str)[:4000]}\n```"
    except Exception as e:
        logger.warning(f"Failed to fetch fact snapshot: {e}")
    return ""

def _build_messages(messages: list[ChatMessage], system_context: str) -> list[dict]:
    """Build LLM message array with system context enrichment."""
    result = []
    has_system = False
    for msg in messages:
        if msg.role == "system":
            result.append({"role": "system", "content": msg.content + system_context})
            has_system = True
        else:
            result.append({"role": msg.role, "content": msg.content})

    if not has_system:
        soul_path = os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "SOUL.md")
        soul = ""
        if os.path.exists(soul_path):
            with open(soul_path) as f:
                soul = f.read()
        result.insert(0, {"role": "system", "content": soul + system_context})

    return result

@app.post("/v1/chat")
async def chat(req: ChatRequest):
    if not LLM_API_KEY:
        raise HTTPException(status_code=503, detail="No LLM API key configured")

    model = req.model or MODEL
    system_context = await _enrich_with_mcp(req.user_jwt) if req.use_mcp else ""
    messages = _build_messages(req.messages, system_context)

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{LLM_BASE_URL}/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                    "stream": False,
                },
                headers=_build_llm_headers(),
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
                "provider": LLM_PROVIDER,
                "mcp_enriched": bool(system_context),
            }
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="LLM request timed out")

@app.post("/v1/chat/stream")
async def chat_stream(req: ChatRequest):
    if not LLM_API_KEY:
        raise HTTPException(status_code=503, detail="No LLM API key configured")

    model = req.model or MODEL
    system_context = await _enrich_with_mcp(req.user_jwt) if req.use_mcp else ""
    messages = _build_messages(req.messages, system_context)

    async def event_stream():
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{LLM_BASE_URL}/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                    "stream": True,
                },
                headers=_build_llm_headers(),
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
