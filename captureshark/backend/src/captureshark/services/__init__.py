"""Services — application use cases.

A service orchestrates domain logic and one or more adapters to satisfy a
single use case (e.g. "extract a capture", "save a row to a sheet"). It
receives adapter implementations through its constructor — never instantiates
them directly — so tests can substitute fakes.

Routers in `api/routes/` should be 5-10 lines: deserialize → call service →
serialize. If a router grows past that, the missing logic belongs in a
service.
"""
