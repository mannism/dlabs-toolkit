-- Reference DDL for @diabolicallabs/prompt-registry — admin-standard §S7 prompt_versions table.
-- Applied idempotently by PostgresPromptStorageAdapter.ensureSchema() (IF NOT EXISTS throughout).
-- Consumers using their own migration tool (Drizzle, etc.) may hand-author an equivalent
-- migration instead — this file is the canonical shape, not a mandatory migration runner.

CREATE TABLE IF NOT EXISTS prompt_versions (
  id             BIGSERIAL PRIMARY KEY,
  prompt_name    VARCHAR(100) NOT NULL,
  prompt_type    VARCHAR(50)  NOT NULL,
  version        INTEGER      NOT NULL,
  content        TEXT         NOT NULL,
  is_active      BOOLEAN      NOT NULL DEFAULT FALSE,
  activated_on   TIMESTAMPTZ,
  created_by     VARCHAR(255),
  change_notes   TEXT,
  created_on     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT prompt_versions_name_type_version_key UNIQUE (prompt_name, prompt_type, version)
);

-- Lookup path for get()/getActiveVersion(): (name, type) filtered to the active row.
CREATE INDEX IF NOT EXISTS idx_prompt_versions_active
  ON prompt_versions (prompt_name, prompt_type)
  WHERE is_active = TRUE;

-- Lookup path for history()/rollback(): full version list ordered newest-first.
CREATE INDEX IF NOT EXISTS idx_prompt_versions_name_type_version
  ON prompt_versions (prompt_name, prompt_type, version DESC);
