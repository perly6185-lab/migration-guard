CREATE TABLE IF NOT EXISTS batch_idempotency (
  tenant_id BIGINT NOT NULL,
  panel_id BIGINT NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  chunk_no INT NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  final_chunk TINYINT(1) NOT NULL DEFAULT 0,
  state VARCHAR(32) NOT NULL,
  response_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, session_id, chunk_no),
  UNIQUE KEY uk_batch_idempotency_key (tenant_id, panel_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS batch_outbox (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  event_kind VARCHAR(64) NOT NULL,
  dedupe_key VARCHAR(255) NOT NULL,
  payload JSON NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_batch_outbox_dedupe (tenant_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS batch_undo_journal (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  row_index INT NOT NULL,
  primary_key_value VARCHAR(255) NULL,
  before_value JSON NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_batch_undo_row (tenant_id, batch_id, row_index)
);

CREATE TABLE IF NOT EXISTS batch_row_projection (
  tenant_id BIGINT NOT NULL,
  panel_id BIGINT NOT NULL,
  primary_key_value VARCHAR(255) NOT NULL,
  values_json JSON NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, panel_id, primary_key_value)
);

-- Disposable projection template used by the L4-B gate. Production startup
-- accepts only a validated cust_table<digits> identifier.
CREATE TABLE IF NOT EXISTS batch_update_fixture_row LIKE batch_row_projection;

CREATE TABLE IF NOT EXISTS batch_row_commit (
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  row_index INT NOT NULL,
  request_hash CHAR(64) NOT NULL,
  primary_key_value VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, batch_id, row_index)
);

CREATE TABLE IF NOT EXISTS schema_transition_ledger (
  tenant_id BIGINT NOT NULL,
  panel_id BIGINT NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  attempt INT NOT NULL,
  state VARCHAR(32) NOT NULL,
  error_message VARCHAR(1024) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, panel_id, operation_id)
);

CREATE TABLE IF NOT EXISTS schema_transition_target (
  id BIGINT NOT NULL,
  PRIMARY KEY (id)
);
