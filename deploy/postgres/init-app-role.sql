-- Optional init script for least-privilege setup.
-- docker-entrypoint creates POSTGRES_USER as superuser of the DB;
-- for production, create a dedicated app role after first boot:
--
--   CREATE ROLE otc_app LOGIN PASSWORD '...';
--   GRANT CONNECT ON DATABASE otc_desk TO otc_app;
--   GRANT USAGE ON SCHEMA public TO otc_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO otc_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO otc_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO otc_app;
--
-- This file is a no-op placeholder so the volume mount always succeeds.

SELECT 1;
