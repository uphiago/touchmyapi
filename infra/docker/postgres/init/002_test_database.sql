SELECT 'CREATE DATABASE touchmyapi_test'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'touchmyapi_test'
)
\gexec
