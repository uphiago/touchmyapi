-- TouchMyAPI local development extensions.
-- pgcrypto: gen_random_uuid() for id generation (data model uses UUID ids).
-- citext:   case-insensitive text, used by user.email (see data-model.md).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
