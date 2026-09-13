# Live Delivery Tracking

Driver GPS in. Live map out.

This repo is not a Swiggy clone. It is one production problem:
thousands of drivers ping location every few seconds, and a customer
must see the latest point with low delay.

Naive path (API → database → polling) does not survive that write rate
or that fan-out. This project builds the pipeline that does:

GPS ingest → Kafka → Redis (latest point) → WebSocket map

Analytics reads the same Kafka topic and must not slow the live path.

## Not in scope

- Restaurants, cart, payments, auth
- A real driver app (a simulator is enough)
- Road snapping / ML ETA (later, if ever)

## Status

Phase 0 — problem statement. Stack and features will land as they are built.

This README will change as the system changes.
