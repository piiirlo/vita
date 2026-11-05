from fastapi import FastAPI

from app.api import charts, connections, dashboards, datasets, health, query, saved_queries

app = FastAPI(title="Vita")

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(connections.router, prefix="/api/connections", tags=["connections"])
app.include_router(query.router, prefix="/api", tags=["query"])
app.include_router(saved_queries.router, prefix="/api/saved-queries", tags=["saved queries"])
app.include_router(datasets.router, prefix="/api/datasets", tags=["datasets"])
app.include_router(charts.router, prefix="/api", tags=["charts"])
app.include_router(dashboards.router, prefix="/api/dashboards", tags=["dashboards"])
