from fastapi import FastAPI

from app.api import connections, health

app = FastAPI(title="Vita")

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(connections.router, prefix="/api/connections", tags=["connections"])
