"""Compile public queries and evaluate normalized trace fields."""

from dataclasses import dataclass
import unicodedata


def normalize(value):
    return unicodedata.normalize("NFKC", value).casefold().strip()


@dataclass(frozen=True)
class QueryPlan:
    levels: tuple
    services: tuple
    tags: tuple
    terms: tuple
    minimum: int | None
    maximum: int | None
    limit: int | None

    @classmethod
    def compile(cls, query):
        limit = int(query["limit"]) if query.get("limit") is not None else None
        if limit is not None and limit < 0:
            raise ValueError("limit must be non-negative")
        groups = [tuple(sorted({normalize(value) for value in query.get(key, [])}))
                  for key in ("levels", "services", "tags", "terms")]
        minimum = int(query["min_timestamp"]) if "min_timestamp" in query else None
        maximum = int(query["max_timestamp"]) if "max_timestamp" in query else None
        return cls(*groups, minimum, maximum, limit)

    @property
    def cache_key(self):
        return (self.levels, self.services, self.tags, self.terms,
                self.minimum, self.maximum, self.limit)

    def select(self, records):
        if self.limit == 0:
            return []
        rows = []
        for raw in records:
            timestamp = int(raw["timestamp"])
            if self.minimum is not None and timestamp < self.minimum:
                continue
            if self.maximum is not None and timestamp > self.maximum:
                continue
            level = normalize(raw["level"])
            if self.levels and level not in self.levels:
                continue
            service = normalize(raw["service"])
            if self.services and service not in self.services:
                continue
            tags = [normalize(value) for value in raw["tags"]]
            if not all(tag in tags for tag in self.tags):
                continue
            message = normalize(raw["message"])
            if not all(term in message for term in self.terms):
                continue
            rows.append({"id": normalize(raw["id"]), "timestamp": timestamp,
                         "service": service, "level": level,
                         "message": message, "tags": tags})
            if self.limit is not None and len(rows) >= self.limit:
                break
        return rows
