from fastapi import FastAPI

from app.api import connections, health, query

app = FastAPI(title="Vita")

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(connections.router, prefix="/api/connections", tags=["connections"])
app.include_router(query.router, prefix="/api", tags=["query"])
