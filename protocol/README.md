# Home Cinema Protocol 1.0

This directory is the source of truth for messages exchanged between the
session coordinator and browser endpoints. JSON Schema documents define the
wire contract. Runtime implementations must not silently add alternative field
names or reinterpret time fields.

## Envelope

Every message uses the envelope in `schemas/envelope.schema.json`:

```json
{
  "protocol_version": "1.0",
  "message_type": "playback.arm",
  "session_id": "session-123",
  "server_incarnation_id": "incarnation-456",
  "epoch": 8,
  "sequence": 1,
  "message_id": "message-789",
  "sent_at_server_ms": 1783681200123.5,
  "payload": {}
}
```

## Identity and ordering

- `session_id` identifies a room session.
- `server_incarnation_id` identifies one coordinator process lifetime. A change
  invalidates client clock mappings and scheduled commands.
- `epoch` identifies one version of the playback timeline.
- `sequence` orders commands within one epoch.
- `message_id` makes a single message idempotent.
- `revision` belongs to a session snapshot and supports compare-and-swap state
  updates. It is not a wire-message ordering field.

## Time fields

`sent_at_server_ms` and `effective_at_server_ms` are server wall-timeline
milliseconds. They are mapped by the client to `performance.now()`, then to
`AudioContext.currentTime`.

Server monotonic nanoseconds never appear on the wire. They are process-local
and are used for elapsed durations, timeouts, and performance measurement.

## Phase 1 message types

Client to server:

- `endpoint.hello`
- `endpoint.heartbeat`
- `clock.probe_response`
- `asset.ready`
- `playback.status`
- `telemetry.report`

Server to client:

- `session.snapshot`
- `clock.probe`
- `asset.preload`
- `playback.arm`
- `playback.cancel`
- `playback.stop`

## State guarantees

`READY` means the required asset is fetched, decoded, and matches the active
manifest. `ARMED` means the endpoint has successfully scheduled the audio on
its local AudioContext timeline. These guarantees must not be merged.

An endpoint must reject an ARM when:

- the server incarnation does not match;
- its epoch is stale;
- the manifest does not match the decoded local asset;
- the AudioContext is not running;
- clock confidence is below policy;
- the remaining lead is smaller than `minimum_buffer_lead_ms`.

## Compatibility

Protocol changes that remove fields, change meanings, or tighten accepted
values require a new protocol version. Optional additive fields may be made in
a backwards-compatible minor revision after both endpoints have feature
negotiation.
