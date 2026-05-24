"""Declarative base for all SQLAlchemy ORM models.

Single shared `Base` so Alembic's autogenerate sees every table from one
metadata object. Adapter-layer ORM modules (`adapters/orm.py`) define
their tables against this base; nothing in `domain/` imports from here.

`MappedAsDataclass` makes ORM rows behave like dataclasses — frozen-style
ergonomics, free `__repr__`, free positional/keyword construction — while
still being SQLAlchemy-tracked. It pairs cleanly with `Mapped[T]` type
annotations under `mypy --strict`.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase, MappedAsDataclass


class Base(MappedAsDataclass, DeclarativeBase):
    """Project-wide declarative base. Do not subclass outside `adapters/`."""
