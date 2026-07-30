import hashlib
import json
import os
import re
from datetime import datetime, timezone

import pymysql


MYSQL_HOST = os.environ.get("MG_MYSQL_HOST", "10.10.10.14")
MYSQL_PORT = int(os.environ.get("MG_MYSQL_PORT", "3306"))
MYSQL_DATABASE = os.environ["MG_MYSQL_DATABASE"]
MYSQL_USERNAME = os.environ["MG_MYSQL_USERNAME"]
MYSQL_PASSWORD = os.environ["MG_MYSQL_PASSWORD"]
TENANT_ID = int(os.environ["MG_JAVA_TENANT_ID"])
FILE_ID = int(os.environ["MG_FILE_ID"])
MENU_ID = int(os.environ["MG_MENU_ID"])
FILE_NAME = os.environ["MG_FILE_NAME"]
BATCH_ID = os.environ.get("MG_BATCH_ID")
USE_PAGE_ID = os.environ.get("MG_USE_PAGE_ID")
PAGE_ID = os.environ.get("MG_PAGE_ID")


connection = pymysql.connect(
    host=MYSQL_HOST,
    port=MYSQL_PORT,
    user=MYSQL_USERNAME,
    password=MYSQL_PASSWORD,
    database=MYSQL_DATABASE,
    charset="utf8mb4",
    connect_timeout=5,
    read_timeout=15,
    write_timeout=15,
    autocommit=False,
    cursorclass=pymysql.cursors.DictCursor,
)
try:
    with connection.cursor() as cursor:
        cursor.execute("SET SESSION TRANSACTION READ ONLY")
        cursor.execute("START TRANSACTION READ ONLY")
        cursor.execute(
            """
            SELECT
                batch_id,
                file_id,
                file_name,
                menu_id,
                task_status,
                total_rows,
                total_sheet_count,
                create_time
            FROM boss_ledger_import_batch_record
            WHERE tenant_id = %s
              AND deleted = 0
              AND (
                    file_id = %s
                    OR (menu_id = %s AND file_name = %s)
              )
            ORDER BY create_time DESC, id DESC
            LIMIT 20
            """,
            (TENANT_ID, FILE_ID, MENU_ID, FILE_NAME),
        )
        rows = cursor.fetchall()
        cursor.execute(
            """
            SELECT
                COUNT(*) AS batch_count,
                COALESCE(MAX(create_time), '1970-01-01 00:00:00')
                    AS latest_create_time
            FROM boss_ledger_import_batch_record
            WHERE tenant_id = %s
              AND deleted = 0
            """,
            (TENANT_ID,),
        )
        totals = cursor.fetchone()
        cursor.execute(
            """
            SELECT COUNT(*) AS page_count
            FROM boss_view_dynamic_page_data
            WHERE tenant_id = %s
              AND deleted = 0
            """,
            (TENANT_ID,),
        )
        page_totals = cursor.fetchone()
        resource_evidence = None
        if BATCH_ID and USE_PAGE_ID and PAGE_ID:
            cursor.execute(
                """
                SELECT
                    batch_id,
                    file_id,
                    menu_id,
                    task_status,
                    current_phase,
                    total_rows,
                    processed_rows,
                    success_count,
                    error_count,
                    insert_count,
                    update_count,
                    skip_count,
                    create_time,
                    update_time
                FROM boss_ledger_import_batch_record
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND batch_id = %s
                """,
                (TENANT_ID, int(BATCH_ID)),
            )
            batch_row = cursor.fetchone()
            cursor.execute(
                """
                SELECT
                    batch_id,
                    sheet_name,
                    ledger_name,
                    use_page_id,
                    page_id,
                    task_status,
                    row_count,
                    processed_rows,
                    success_count,
                    error_count,
                    insert_count,
                    update_count,
                    skip_count
                FROM boss_ledger_import_sheet_record
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND batch_id = %s
                ORDER BY sheet_order, id
                """,
                (TENANT_ID, int(BATCH_ID)),
            )
            sheet_rows = cursor.fetchall()
            cursor.execute(
                """
                SELECT
                    id,
                    page_id,
                    page_name,
                    page_open_mode,
                    self_book_page_id,
                    tenant_id,
                    create_time
                FROM boss_view_dynamic_use_page_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND id = %s
                """,
                (TENANT_ID, int(USE_PAGE_ID)),
            )
            use_page_row = cursor.fetchone()
            cursor.execute(
                """
                SELECT
                    id,
                    name,
                    page_create_mode,
                    page_open_mode,
                    self_book_page_id,
                    self_book_page_name,
                    tenant_id,
                    create_time
                FROM boss_view_dynamic_page_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND id = %s
                """,
                (TENANT_ID, int(PAGE_ID)),
            )
            page_row = cursor.fetchone()
            cursor.execute(
                """
                SELECT
                    id,
                    pid,
                    name,
                    sheet_name,
                    page_open_mode,
                    self_book_page_id,
                    create_time
                FROM boss_view_dynamic_panel_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND (
                        pid = %s
                        OR create_time BETWEEN (
                            SELECT create_time
                            FROM boss_ledger_import_batch_record
                            WHERE tenant_id = %s
                              AND deleted = 0
                              AND batch_id = %s
                        ) AND DATE_ADD((
                            SELECT create_time
                            FROM boss_ledger_import_batch_record
                            WHERE tenant_id = %s
                              AND deleted = 0
                              AND batch_id = %s
                        ), INTERVAL 10 SECOND)
                  )
                ORDER BY sort, id
                """,
                (
                    TENANT_ID,
                    int(PAGE_ID),
                    TENANT_ID,
                    int(BATCH_ID),
                    TENANT_ID,
                    int(BATCH_ID),
                ),
            )
            panel_rows = cursor.fetchall()
            panel_ids = [row["id"] for row in panel_rows]
            cursor.execute(
                """
                SELECT
                    id,
                    pid,
                    name,
                    table_name,
                    table_field,
                    field_type_value,
                    field_tag_inner_key,
                    self_book_page_id
                FROM boss_view_dynamic_field_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND (
                        pid IN (
                            SELECT id
                            FROM boss_view_dynamic_panel_data
                            WHERE tenant_id = %s
                              AND deleted = 0
                              AND (
                                    pid = %s
                                    OR create_time BETWEEN (
                                        SELECT create_time
                                        FROM boss_ledger_import_batch_record
                                        WHERE tenant_id = %s
                                          AND deleted = 0
                                          AND batch_id = %s
                                    ) AND DATE_ADD((
                                        SELECT create_time
                                        FROM boss_ledger_import_batch_record
                                        WHERE tenant_id = %s
                                          AND deleted = 0
                                          AND batch_id = %s
                                    ), INTERVAL 10 SECOND)
                              )
                        )
                        OR self_book_page_id = %s
                        OR create_time BETWEEN (
                            SELECT create_time
                            FROM boss_ledger_import_batch_record
                            WHERE tenant_id = %s
                              AND deleted = 0
                              AND batch_id = %s
                        ) AND DATE_ADD((
                            SELECT create_time
                            FROM boss_ledger_import_batch_record
                            WHERE tenant_id = %s
                              AND deleted = 0
                              AND batch_id = %s
                        ), INTERVAL 10 SECOND)
                  )
                ORDER BY sort, id
                """,
                (
                    TENANT_ID,
                    TENANT_ID,
                    int(PAGE_ID),
                    TENANT_ID,
                    int(BATCH_ID),
                    TENANT_ID,
                    int(BATCH_ID),
                    int(PAGE_ID),
                    TENANT_ID,
                    int(BATCH_ID),
                    TENANT_ID,
                    int(BATCH_ID),
                ),
            )
            field_rows = cursor.fetchall()
            table_names = sorted(
                {
                    row["table_name"]
                    for row in field_rows
                    if row.get("table_name")
                }
            )
            table_counts = {}
            for table_name in table_names:
                if not re.fullmatch(r"[A-Za-z0-9_]+", table_name):
                    raise RuntimeError(
                        f"unsafe table identifier returned: {table_name!r}"
                    )
                cursor.execute(
                    """
                    SELECT COUNT(*) AS table_exists
                    FROM information_schema.tables
                    WHERE table_schema = %s
                      AND table_name = %s
                    """,
                    (MYSQL_DATABASE, table_name),
                )
                exists = cursor.fetchone()["table_exists"] == 1
                row_count = None
                if exists:
                    cursor.execute(
                        f"SELECT COUNT(*) AS row_count FROM `{table_name}`"
                    )
                    row_count = cursor.fetchone()["row_count"]
                table_counts[table_name] = {
                    "exists": exists,
                    "rowCount": row_count,
                }
            resource_evidence = {
                "batch": batch_row,
                "sheets": sheet_rows,
                "usePage": use_page_row,
                "page": page_row,
                "panels": panel_rows,
                "panelIds": panel_ids,
                "fields": field_rows,
                "physicalTables": table_counts,
            }
    connection.rollback()
finally:
    connection.close()

normalized_rows = [
    {
        **row,
        "batch_id": str(row["batch_id"]),
        "file_id": str(row["file_id"]),
        "menu_id": str(row["menu_id"]),
        "create_time": row["create_time"].isoformat(
            sep=" ",
            timespec="seconds",
        ),
    }
    for row in rows
]
report = {
    "schemaVersion": 1,
    "stage": "zboss-create-ledger-confirm-mysql-snapshot",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "connection": {
        "hostHash": hashlib.sha256(
            MYSQL_HOST.encode("utf-8")
        ).hexdigest(),
        "port": MYSQL_PORT,
        "databaseHash": hashlib.sha256(
            MYSQL_DATABASE.encode("utf-8")
        ).hexdigest(),
        "sessionTransactionReadOnly": True,
    },
    "scope": {
        "tenantHash": hashlib.sha256(
            str(TENANT_ID).encode("utf-8")
        ).hexdigest(),
        "fileId": str(FILE_ID),
        "menuId": str(MENU_ID),
        "fileName": FILE_NAME,
    },
    "matchingBatchCount": len(normalized_rows),
    "matchingBatches": normalized_rows,
    "tenantBatchCount": totals["batch_count"],
    "tenantLatestBatchCreateTime": str(totals["latest_create_time"]),
    "tenantPageCount": page_totals["page_count"],
    "resourceEvidence": resource_evidence,
    "credentialsPersisted": False,
}
encoded = json.dumps(
    report,
    sort_keys=True,
    separators=(",", ":"),
    default=str,
).encode("utf-8")
report["reportHash"] = hashlib.sha256(encoded).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
