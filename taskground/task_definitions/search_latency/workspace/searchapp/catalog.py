"""Version tokens used to identify a consistent view of searchable records."""


class Catalog:
    def __init__(self, store):
        self.store = store

    def token(self, tenant):
        return self.store.revision
