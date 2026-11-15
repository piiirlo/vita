"""Projects (/api/projects): each one owns its connections, uploads, datasets, saved queries,
charts and dashboards. Other routers use `resolve_project` to place new items and to keep
references inside one project (a chart only uses its project's datasets, a dashboard only
its project's charts)."""

import logging
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.models import (
    Chart,
    Connection,
    Dashboard,
    Dataset,
    Project,
    SavedQuery,
    Upload,
)
from app.schemas.projects import ProjectDashboard, ProjectIn, ProjectOut
from app.uploads.datasets import is_upload_dataset
from app.uploads.importer import drop_table as drop_upload_table

log = logging.getLogger(__name__)

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]

DEFAULT_PROJECT = "My workspace"


# ---------- helpers used by the other routers ----------


def project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


def default_project_id(db: Session) -> int:
    """The project used when a request names none (API clients from before projects):
    the oldest one, or a new "My workspace" when there is none."""
    found = db.scalar(select(Project.id).order_by(Project.id).limit(1))
    if found is not None:
        return found
    project = Project(name=DEFAULT_PROJECT)
    db.add(project)
    db.flush()
    return project.id


def resolve_project(
    db: Session, project_id: int | None, owner: int | None = None, what: str = ""
) -> int:
    """The project a new / changed item goes in. `owner` is the project of what it uses (a
    chart's dataset...): it must be the same, and it is the default when none is named."""
    if project_id is not None:
        project_or_404(db, project_id)
        if owner is not None and owner != project_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{what} belongs to another project.")
        return project_id
    if owner is not None:
        return owner
    return default_project_id(db)


def same_project(owner: int | None, project_id: int, what: str) -> None:
    """`owner` None = shared by every project (the built-in Uploads connection)."""
    if owner is not None and owner != project_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{what} belongs to another project.")


# ---------- API ----------


def _out(db: Session, project: Project) -> ProjectOut:
    def count(model: type[Dashboard | Dataset | Chart | SavedQuery | Connection]) -> int:
        return db.scalar(select(func.count()).where(model.project_id == project.id)) or 0

    datasets = list(
        db.scalars(
            select(Dataset)
            .where(Dataset.project_id == project.id)
            .options(selectinload(Dataset.connection))
        )
    )
    sources: list[Literal["database", "file"]] = []
    if count(Connection):
        sources.append("database")
    if any(is_upload_dataset(d) for d in datasets):
        sources.append("file")
    dashboards = db.scalars(
        select(Dashboard)
        .where(Dashboard.project_id == project.id)
        .order_by(Dashboard.updated_at.desc(), Dashboard.id.desc())
        .limit(3)
    )
    return ProjectOut(
        id=project.id,
        name=project.name,
        description=project.description,
        dashboard_count=count(Dashboard),
        dataset_count=len(datasets),
        chart_count=count(Chart),
        connection_count=count(Connection),
        saved_query_count=count(SavedQuery),
        sources=sources,
        dashboards=[
            ProjectDashboard(
                id=d.id,
                name=d.name,
                chart_count=sum(1 for t in d.layout if t.get("type") == "chart"),
            )
            for d in dashboards
        ],
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _name_taken(name: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, "A project with that name already exists.")


def _check_name_free(db: Session, name: str, project_id: int | None = None) -> None:
    stmt = select(Project.id).where(func.lower(Project.name) == name.lower())
    if project_id is not None:
        stmt = stmt.where(Project.id != project_id)
    if db.scalar(stmt) is not None:
        raise _name_taken(name)


def _commit(db: Session, name: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _name_taken(name) from None


@router.get("", response_model=list[ProjectOut])
def list_projects(db: DbSession) -> list[ProjectOut]:
    projects = db.scalars(select(Project).order_by(Project.created_at, Project.id))
    return [_out(db, p) for p in projects]


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectIn, db: DbSession) -> ProjectOut:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Give the project a name.")
    _check_name_free(db, name)
    project = Project(name=name, description=(payload.description or "").strip() or None)
    db.add(project)
    _commit(db, name)
    db.refresh(project)
    return _out(db, project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, db: DbSession) -> ProjectOut:
    return _out(db, project_or_404(db, project_id))


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, payload: ProjectIn, db: DbSession) -> ProjectOut:
    project = project_or_404(db, project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Give the project a name.")
    _check_name_free(db, name, project_id)
    project.name = name
    project.description = (payload.description or "").strip() or None
    _commit(db, name)
    db.refresh(project)
    return _out(db, project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int, db: DbSession, confirm: Annotated[str, Query(max_length=100)] = ""
) -> Response:
    """Deletes the project and everything in it: dashboards, charts, datasets, saved queries,
    connections, uploads, and the tables its uploaded files became. `confirm` must be the
    project's name (typed by the user)."""
    project = project_or_404(db, project_id)
    if confirm.strip() != project.name:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Type the project's name exactly to delete it."
        )
    datasets = list(
        db.scalars(
            select(Dataset)
            .where(Dataset.project_id == project_id)
            .options(selectinload(Dataset.connection))
        )
    )
    # Uploaded tables read only by this project's datasets.
    mine = {d.id for d in datasets}
    tables = {d.table_name for d in datasets if is_upload_dataset(d) and d.table_name}
    others = db.scalars(
        select(Dataset)
        .where(Dataset.project_id != project_id)
        .options(selectinload(Dataset.connection))
    )
    for other in others:
        if other.id not in mine and other.table_name in tables and is_upload_dataset(other):
            tables.discard(other.table_name)

    db.execute(delete(Dashboard).where(Dashboard.project_id == project_id))
    db.execute(delete(Chart).where(Chart.project_id == project_id))
    db.execute(update(Upload).where(Upload.dataset_id.in_(mine)).values(dataset_id=None))
    db.execute(delete(Upload).where(Upload.project_id == project_id))
    for dataset in datasets:
        db.delete(dataset)  # columns and metrics with it
    db.flush()
    db.execute(delete(SavedQuery).where(SavedQuery.project_id == project_id))
    # Datasets of other projects can't use these connections (same-project rule).
    db.execute(delete(Connection).where(Connection.project_id == project_id))
    db.delete(project)
    db.commit()
    for table in sorted(tables):
        # After the commit: a table that can't be dropped is only wasted space.
        try:
            drop_upload_table(table)
        except psycopg.Error:
            log.warning("Couldn't drop upload table %s", table, exc_info=True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
