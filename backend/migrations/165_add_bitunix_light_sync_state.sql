-- Persist Bitunix light-sync state so scheduled syncs can skip unchanged snapshots

ALTER TABLE broker_connections
ADD COLUMN IF NOT EXISTS bitunix_last_positions_hash TEXT,
ADD COLUMN IF NOT EXISTS bitunix_last_positions_checked_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN broker_connections.bitunix_last_positions_hash IS 'Last processed Bitunix light-sync snapshot hash';
COMMENT ON COLUMN broker_connections.bitunix_last_positions_checked_at IS 'Timestamp of the latest Bitunix light-sync snapshot check';
