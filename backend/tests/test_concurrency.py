"""A slow query must not block other requests (endpoints are sync and run in a threadpool)."""

import threading
import time
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

Payload = Callable[..., dict[str, Any]]


def test_slow_query_does_not_block_other_requests(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post("/api/connections", json=sampledb_payload()).json()["id"]
    slow: dict[str, Any] = {}

    def run_slow() -> None:
        started = time.perf_counter()
        response = client.post(
            "/api/query", json={"connection_id": conn_id, "sql": "SELECT pg_sleep(3)"}
        )
        slow["status"] = response.status_code
        slow["seconds"] = time.perf_counter() - started

    thread = threading.Thread(target=run_slow)
    thread.start()
    time.sleep(0.5)  # make sure the slow query is running

    started = time.perf_counter()
    health = client.get("/api/health")
    health_seconds = time.perf_counter() - started

    started = time.perf_counter()
    other = client.post("/api/query", json={"connection_id": conn_id, "sql": "SELECT 1"})
    other_seconds = time.perf_counter() - started

    assert thread.is_alive(), "the slow query should still be running"
    thread.join(timeout=15)

    assert health.status_code == 200
    assert other.status_code == 200
    assert health_seconds < 1
    assert other_seconds < 1
    assert slow["status"] == 200
    assert slow["seconds"] >= 3
