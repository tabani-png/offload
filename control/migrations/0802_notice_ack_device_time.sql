-- S2-08 follow-up (PR #10 review round 2): a synced acknowledgement counts from when the server received it
-- (acknowledged_at_ms); the time the device reported is kept here as a record only. Null for web acks.
ALTER TABLE notice_acks ADD COLUMN device_acknowledged_at_ms bigint;
