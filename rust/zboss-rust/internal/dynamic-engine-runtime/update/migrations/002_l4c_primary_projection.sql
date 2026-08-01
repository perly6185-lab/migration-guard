-- Isolated target projection for SH-3C primary-success replay.
-- This schema is created before replay; the approved scenario itself performs
-- no schema changes and cleans only marker-scoped rows.
CREATE TABLE IF NOT EXISTS cust_table7272 LIKE batch_row_projection;
