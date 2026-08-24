-- Function EXECUTE is unusable without schema USAGE. Keep both queue login
-- connectors function-only: resolution is allowed, object creation is not.
GRANT USAGE ON SCHEMA app_private TO queue_connector, admin_queue_connector;
REVOKE CREATE ON SCHEMA app_private FROM queue_connector, admin_queue_connector;
