"""Adapters — concrete implementations of domain ports.

Each adapter is a thin shim between a domain `Port` interface and an external
service (OpenAI, Google Sheets, the filesystem, etc.). Adapters contain the
SDK-specific code; they do not contain business logic.

Why this separation: services and domain code can be tested with in-memory
fakes that implement the same `Port` interface, without ever hitting a real
network.
"""
