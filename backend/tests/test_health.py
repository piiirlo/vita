from fastapi.testclient import TestClient


def test_health_reports_backend_and_database_ok(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok", "detail": None}
