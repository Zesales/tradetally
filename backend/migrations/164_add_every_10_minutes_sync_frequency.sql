-- Add 10-minute broker sync frequency for existing databases

ALTER TABLE broker_connections
DROP CONSTRAINT IF EXISTS broker_connections_sync_frequency_check;

ALTER TABLE broker_connections
ADD CONSTRAINT broker_connections_sync_frequency_check
CHECK (
  sync_frequency IN (
    'manual',
    'every_10_minutes',
    'hourly',
    'every_4_hours',
    'every_6_hours',
    'every_12_hours',
    'daily'
  )
);

COMMENT ON COLUMN broker_connections.sync_frequency IS 'Sync frequency: manual, every_10_minutes, hourly, every_4_hours, every_6_hours, every_12_hours, or daily';
