CREATE TABLE IF NOT EXISTS delete_idempotency (
  tenant_id BIGINT NOT NULL,
  panel_id BIGINT NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  state VARCHAR(32) NOT NULL,
  response_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, panel_id, idempotency_key),
  UNIQUE KEY uk_delete_idempotency_batch (tenant_id, batch_id)
);

-- Disposable protocol projection used only by the container gate. Production
-- adapters substitute the validated cust_table<digits> identifier.
CREATE TABLE IF NOT EXISTS delete_fixture_row (
  tenant_id BIGINT NOT NULL,
  panel_id BIGINT NOT NULL,
  id BIGINT NOT NULL,
  material_name VARCHAR(255) NOT NULL,
  material_quantity INT NOT NULL,
  referenced_flag TINYINT(1) NOT NULL DEFAULT 0,
  deleted TINYINT(1) NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_by BIGINT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, panel_id, id)
);

CREATE TABLE IF NOT EXISTS delete_snapshot (
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  row_id BIGINT NOT NULL,
  row_version BIGINT NOT NULL,
  snapshot_json JSON NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, batch_id, row_id)
);

CREATE TABLE IF NOT EXISTS delete_undo_anchor (
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  row_id BIGINT NOT NULL,
  snapshot_row_id BIGINT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, batch_id, row_id)
);

CREATE TABLE IF NOT EXISTS delete_compensation_outbox (
  tenant_id BIGINT NOT NULL,
  panel_id BIGINT NOT NULL DEFAULT 0,
  batch_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL DEFAULT '',
  request_hash CHAR(64) NOT NULL,
  row_ids JSON NOT NULL,
  requested_rows INT NOT NULL DEFAULT 0,
  deleted_rows INT NOT NULL DEFAULT 0,
  skipped_rows INT NOT NULL DEFAULT 0,
  progress_sequence BIGINT NOT NULL DEFAULT 2,
  state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  next_step INT NOT NULL DEFAULT 0,
  owner_token VARCHAR(128) NULL,
  owner_expires_at TIMESTAMP(6) NULL,
  terminal_error VARCHAR(1024) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, batch_id)
);

CREATE TABLE IF NOT EXISTS delete_compensation_step (
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  step_index INT NOT NULL,
  step_name VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  owner_token VARCHAR(128) NULL,
  error_message VARCHAR(1024) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, batch_id, step_index),
  CONSTRAINT fk_delete_compensation_step_outbox
    FOREIGN KEY (tenant_id, batch_id)
    REFERENCES delete_compensation_outbox (tenant_id, batch_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delete_compensation_effect (
  tenant_id BIGINT NOT NULL,
  batch_id VARCHAR(128) NOT NULL,
  step_index INT NOT NULL,
  step_name VARCHAR(64) NOT NULL,
  effect_payload JSON NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, batch_id, step_index),
  CONSTRAINT fk_delete_compensation_effect_outbox
    FOREIGN KEY (tenant_id, batch_id)
    REFERENCES delete_compensation_outbox (tenant_id, batch_id)
    ON DELETE CASCADE
);
