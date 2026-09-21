"""Detach mutable endpoint responses from internal cached rows."""

from copy import deepcopy


def render(request_id, tenant, rows):
    return {"request_id": request_id, "tenant": tenant, "rows": deepcopy(rows)}
