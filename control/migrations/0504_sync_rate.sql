-- Per-device rate limit on sync ingest (PR #9 wave C item 3): ingest counts the objects a device got accepted in the
-- last hour on every envelope.
CREATE INDEX sync_objects_device_received ON sync_objects (tenant_id, device_id, received_at);
