"""Unit tests for `adapters/assemblyai_token_provider`.

`httpx.MockTransport` stubs AssemblyAI's `/v3/token` endpoint so we can
pin the response → outcome mapping without going over the wire.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest

from captureshark.adapters.assemblyai_token_provider import AssemblyAITokenProvider
from captureshark.domain.live_captions import LiveCaptionTokenErrorKind


def _build_provider(handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return AssemblyAITokenProvider(api_key="test-key", http_client=client), client


@pytest.mark.asyncio
async def test_mint_token_success_returns_token_and_expiry() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/v3/token"
        assert request.url.params["expires_in_seconds"] == "60"
        assert request.headers["Authorization"] == "test-key"
        return httpx.Response(200, json={"token": "assemblyai-temp-abc"})

    provider, client = _build_provider(handler)
    before = datetime.now(UTC)
    try:
        outcome = await provider.mint_token(expires_in_seconds=60)
    finally:
        await client.aclose()
    after = datetime.now(UTC)

    assert outcome[0] == "ok"
    token = outcome[1]
    assert token.token == "assemblyai-temp-abc"
    # Expiry should land ~60s after we called; allow ±2s for jitter.
    delta_seconds = (token.expires_at - before).total_seconds()
    assert 58 <= delta_seconds <= 62
    assert token.expires_at > after


@pytest.mark.asyncio
async def test_mint_token_network_error_maps_to_upstream_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    provider, client = _build_provider(handler)
    try:
        outcome = await provider.mint_token(expires_in_seconds=60)
    finally:
        await client.aclose()

    assert outcome[0] == "error"
    assert outcome[1].kind == LiveCaptionTokenErrorKind.UPSTREAM_UNAVAILABLE


@pytest.mark.asyncio
async def test_mint_token_4xx_maps_to_upstream_rejected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    provider, client = _build_provider(handler)
    try:
        outcome = await provider.mint_token(expires_in_seconds=60)
    finally:
        await client.aclose()

    assert outcome[0] == "error"
    assert outcome[1].kind == LiveCaptionTokenErrorKind.UPSTREAM_REJECTED


@pytest.mark.asyncio
async def test_mint_token_non_json_response_maps_to_unexpected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>nope</html>")

    provider, client = _build_provider(handler)
    try:
        outcome = await provider.mint_token(expires_in_seconds=60)
    finally:
        await client.aclose()

    assert outcome[0] == "error"
    assert outcome[1].kind == LiveCaptionTokenErrorKind.UNEXPECTED


@pytest.mark.asyncio
async def test_mint_token_missing_token_field_maps_to_unexpected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps({"not_token": "x"}))

    provider, client = _build_provider(handler)
    try:
        outcome = await provider.mint_token(expires_in_seconds=60)
    finally:
        await client.aclose()

    assert outcome[0] == "error"
    assert outcome[1].kind == LiveCaptionTokenErrorKind.UNEXPECTED
