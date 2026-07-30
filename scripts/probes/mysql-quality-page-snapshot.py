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
PANEL_ID = int(os.environ["MG_PANEL_ID"])
PAGE_ID = int(os.environ["MG_PAGE_ID"])
USE_PAGE_ID = int(os.environ["MG_USE_PAGE_ID"])
SELECT_KEYS = [
    "custField60047",
    "custField60048",
    "custField60049",
    "custField60050",
    "custField60051",
    "custField60073",
    "custField60173",
    "custField60072",
    "custField60046",
    "custField60064",
    "custField60045",
    "custField60065",
    "custField60066",
    "custField60067",
    "custField60052",
]


def safe_identifier(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z0-9_]+",
        value,
    ):
        raise RuntimeError(f"unsafe identifier: {value!r}")
    return value


connection = pymysql.connect(
    host=MYSQL_HOST,
    port=MYSQL_PORT,
    user=MYSQL_USERNAME,
    password=MYSQL_PASSWORD,
    database=MYSQL_DATABASE,
    charset="utf8mb4",
    connect_timeout=5,
    read_timeout=20,
    write_timeout=20,
    autocommit=False,
    cursorclass=pymysql.cursors.DictCursor,
)
try:
    with connection.cursor() as cursor:
        cursor.execute("SET SESSION TRANSACTION READ ONLY")
        cursor.execute("START TRANSACTION READ ONLY")

        table_names = [
            "boss_view_dynamic_config_field_data",
            "boss_view_dynamic_field_data",
            "boss_view_dynamic_panel_data",
            "boss_view_dynamic_use_page_data",
            "boss_view_dynamic_use_layout_field_data",
            "boss_view_dynamic_use_layout_condition_data",
        ]
        placeholders = ",".join(["%s"] * len(table_names))
        cursor.execute(
            f"""
            SELECT
                table_name AS source_table_name,
                column_name AS source_column_name
            FROM information_schema.columns
            WHERE table_schema = %s
              AND table_name IN ({placeholders})
            ORDER BY table_name, ordinal_position
            """,
            (MYSQL_DATABASE, *table_names),
        )
        schema_rows = cursor.fetchall()
        columns = {}
        for row in schema_rows:
            columns.setdefault(row["source_table_name"], set()).add(
                row["source_column_name"]
            )

        cursor.execute(
            """
            SELECT
                id,
                panel_id,
                page_id,
                field_id,
                field_code,
                field_name,
                field_exp,
                field_comment,
                group_code,
                table_name,
                table_field,
                table_script_field,
                released,
                locked
            FROM boss_view_dynamic_config_field_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND panel_id = %s
            ORDER BY id
            """,
            (TENANT_ID, PANEL_ID),
        )
        config_fields = cursor.fetchall()

        cursor.execute(
            """
            SELECT
                id,
                use_layout_id,
                panel_field_id,
                panel_field,
                panel_field_name,
                table_name,
                table_field,
                table_script_field,
                where_exp,
                field_tag_inner_key
            FROM boss_view_dynamic_use_layout_field_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND panel_id = %s
            ORDER BY sort, id
            """,
            (TENANT_ID, PANEL_ID),
        )
        use_layout_fields = cursor.fetchall()

        cursor.execute(
            """
            SELECT
                id,
                use_layout_id,
                left_panel_field_id,
                left_panel_field,
                left_panel_field_name,
                left_table_name,
                left_table_field,
                left_table_script_field,
                where_exp,
                field_type_value
            FROM boss_view_dynamic_use_layout_condition_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND left_panel_id = %s
            ORDER BY sort, id
            """,
            (TENANT_ID, PANEL_ID),
        )
        use_layout_conditions = cursor.fetchall()

        cursor.execute(
            """
            SELECT
                id,
                field,
                name,
                table_name,
                table_field,
                table_script_field,
                where_exp,
                field_quality_tag
            FROM boss_view_dynamic_field_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND where_exp IN (13, 14)
            ORDER BY id
            LIMIT 100
            """,
            (TENANT_ID,),
        )
        global_field_null_semantics = cursor.fetchall()

        cursor.execute(
            """
            SELECT
                id,
                panel_id,
                panel_field_id,
                panel_field,
                table_name,
                table_field,
                table_script_field,
                where_exp
            FROM boss_view_dynamic_use_layout_field_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND where_exp IN (13, 14)
            ORDER BY id
            LIMIT 100
            """,
            (TENANT_ID,),
        )
        global_layout_field_null_semantics = cursor.fetchall()

        cursor.execute(
            """
            SELECT
                id,
                left_panel_id,
                left_panel_field_id,
                left_panel_field,
                left_table_name,
                left_table_field,
                left_table_script_field,
                where_exp
            FROM boss_view_dynamic_use_layout_condition_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND where_exp IN (13, 14)
            ORDER BY id
            LIMIT 100
            """,
            (TENANT_ID,),
        )
        global_layout_condition_null_semantics = cursor.fetchall()

        field_columns = columns.get(
            "boss_view_dynamic_field_data",
            set(),
        )
        wanted_field_columns = [
            name
            for name in [
                "id",
                "field",
                "field_code",
                "name",
                "table_name",
                "table_field",
                "table_script_field",
                "where_exp",
                "field_quality_tag",
                "selected",
                "field_show_tag",
                "tenant_id",
                "deleted",
            ]
            if name in field_columns
        ]
        field_rows = []
        field_ids = sorted(
            {
                int(row["field_id"])
                for row in config_fields
                if row.get("field_id") is not None
            }
        )
        if field_ids:
            field_placeholders = ",".join(["%s"] * len(field_ids))
            cursor.execute(
                f"""
                SELECT {",".join(wanted_field_columns)}
                FROM boss_view_dynamic_field_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND id IN ({field_placeholders})
                ORDER BY id
                """,
                (TENANT_ID, *field_ids),
            )
            field_rows = cursor.fetchall()

        selected_field_rows = []
        if "field" in field_columns:
            select_placeholders = ",".join(
                ["%s"] * len(SELECT_KEYS)
            )
            selected_predicates = [
                f"field IN ({select_placeholders})"
            ]
            selected_parameters = [*SELECT_KEYS]
            if "field_code" in field_columns:
                selected_predicates.append(
                    f"field_code IN ({select_placeholders})"
                )
                selected_parameters.extend(SELECT_KEYS)
            cursor.execute(
                f"""
                SELECT {",".join(wanted_field_columns)}
                FROM boss_view_dynamic_field_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND ({" OR ".join(selected_predicates)})
                ORDER BY id
                """,
                (TENANT_ID, *selected_parameters),
            )
            selected_field_rows = cursor.fetchall()
        if selected_field_rows:
            merged = {
                int(row["id"]): row
                for row in [*field_rows, *selected_field_rows]
                if row.get("id") is not None
            }
            field_rows = list(merged.values())

        table_scoped_null_fields = []
        selected_table_names = sorted(
            {
                row.get("table_name")
                for row in selected_field_rows
                if row.get("table_name")
            }
        )
        if selected_table_names and "where_exp" in field_columns:
            table_placeholders = ",".join(
                ["%s"] * len(selected_table_names)
            )
            cursor.execute(
                f"""
                SELECT {",".join(wanted_field_columns)}
                FROM boss_view_dynamic_field_data
                WHERE tenant_id = %s
                  AND deleted = 0
                  AND table_name IN ({table_placeholders})
                  AND where_exp IN (13, 14)
                ORDER BY id
                """,
                (TENANT_ID, *selected_table_names),
            )
            table_scoped_null_fields = cursor.fetchall()

        selected_table_counts = {}
        for selected_table_name in selected_table_names:
            safe_identifier(selected_table_name)
            cursor.execute(
                f"""
                SELECT COUNT(*) AS active_rows
                FROM `{selected_table_name}`
                WHERE tenant_id = %s
                  AND deleted = 0
                """,
                (TENANT_ID,),
            )
            selected_table_counts[selected_table_name] = (
                cursor.fetchone()["active_rows"]
            )

        field_by_id = {
            int(row["id"]): row
            for row in field_rows
            if row.get("id") is not None
        }
        candidates = []
        candidate_sources = [
            (
                config,
                field_by_id.get(int(config["field_id"])) or {},
            )
            for config in config_fields
        ]
        candidate_sources.extend(
            ({}, field)
            for field in [
                *selected_field_rows,
                *table_scoped_null_fields,
            ]
            if field.get("where_exp") in {13, 14}
        )
        candidate_sources.extend(
            (
                {
                    "id": row.get("id"),
                    "field_id": row.get("panel_field_id"),
                    "field_name": row.get("panel_field"),
                    "field_code": row.get("panel_field"),
                    "field_exp": row.get("where_exp"),
                    "field_comment": row.get("panel_field_name"),
                    "table_name": row.get("table_name"),
                    "table_field": row.get("table_field"),
                    "table_script_field": row.get(
                        "table_script_field"
                    ),
                },
                {
                    "id": row.get("panel_field_id"),
                    "field": row.get("panel_field"),
                    "name": row.get("panel_field_name"),
                    "where_exp": row.get("where_exp"),
                    "field_quality_tag": None,
                    "table_name": row.get("table_name"),
                    "table_field": row.get("table_field"),
                    "table_script_field": row.get(
                        "table_script_field"
                    ),
                },
            )
            for row in use_layout_fields
            if row.get("where_exp") in {13, 14}
        )
        candidate_sources.extend(
            (
                {
                    "id": row.get("id"),
                    "field_id": row.get("left_panel_field_id"),
                    "field_name": row.get("left_panel_field"),
                    "field_code": row.get("left_panel_field"),
                    "field_exp": row.get("where_exp"),
                    "field_comment": row.get(
                        "left_panel_field_name"
                    ),
                    "table_name": row.get("left_table_name"),
                    "table_field": row.get("left_table_field"),
                    "table_script_field": row.get(
                        "left_table_script_field"
                    ),
                },
                {
                    "id": row.get("left_panel_field_id"),
                    "field": row.get("left_panel_field"),
                    "name": row.get("left_panel_field_name"),
                    "where_exp": row.get("where_exp"),
                    "field_quality_tag": None,
                    "table_name": row.get("left_table_name"),
                    "table_field": row.get("left_table_field"),
                    "table_script_field": row.get(
                        "left_table_script_field"
                    ),
                },
            )
            for row in use_layout_conditions
            if row.get("where_exp") in {13, 14}
        )
        seen_candidate_ids = set()
        for config, field in candidate_sources:
            where_exp = field.get("where_exp")
            if where_exp not in {13, 14} and config.get(
                "field_exp"
            ) not in {13, 14}:
                continue
            table_name = (
                field.get("table_name")
                or config.get("table_name")
            )
            table_field = (
                field.get("table_script_field")
                or field.get("table_field")
                or config.get("table_script_field")
                or config.get("table_field")
            )
            field_id = field.get("id") or config.get("field_id")
            if field_id in seen_candidate_ids:
                continue
            seen_candidate_ids.add(field_id)
            candidate = {
                "configId": (
                    str(config["id"])
                    if config.get("id") is not None
                    else None
                ),
                "fieldId": str(field_id),
                "fieldKey": (
                    field.get("field")
                    or config.get("field_name")
                    or config.get("field_code")
                ),
                "fieldName": field.get("name"),
                "fieldCode": (
                    field.get("field_code")
                    or config.get("field_code")
                ),
                "whereExp": where_exp,
                "configFieldExp": config.get("field_exp"),
                "fieldQualityTag": field.get("field_quality_tag"),
                "tableName": table_name,
                "tableField": table_field,
            }
            if table_name and table_field:
                safe_identifier(table_name)
                safe_identifier(table_field)
                cursor.execute(
                    """
                    SELECT COUNT(*) AS table_exists
                    FROM information_schema.tables
                    WHERE table_schema = %s
                      AND table_name = %s
                    """,
                    (MYSQL_DATABASE, table_name),
                )
                table_exists = (
                    cursor.fetchone()["table_exists"] == 1
                )
                candidate["physicalTableExists"] = table_exists
                if table_exists:
                    cursor.execute(
                        f"""
                        SELECT
                            COUNT(*) AS total_rows,
                            SUM(CASE
                                WHEN `{table_field}` IS NULL
                                  OR CAST(`{table_field}` AS CHAR) = ''
                                THEN 1 ELSE 0
                            END) AS null_or_empty_rows,
                            SUM(CASE
                                WHEN `{table_field}` IS NOT NULL
                                 AND CAST(`{table_field}` AS CHAR) <> ''
                                THEN 1 ELSE 0
                            END) AS non_empty_rows
                        FROM `{table_name}`
                        WHERE tenant_id = %s
                          AND deleted = 0
                        """,
                        (TENANT_ID,),
                    )
                    counts = cursor.fetchone()
                    candidate["physicalCounts"] = counts
            candidates.append(candidate)

        cursor.execute(
            """
            SELECT
                id,
                page_id,
                page_name,
                page_open_mode
            FROM boss_view_dynamic_use_page_data
            WHERE tenant_id = %s
              AND deleted = 0
              AND id = %s
            """,
            (TENANT_ID, USE_PAGE_ID),
        )
        use_page = cursor.fetchone()

    connection.rollback()
finally:
    connection.close()

report = {
    "schemaVersion": 1,
    "stage": "zboss-quality-page-mysql-snapshot",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "connection": {
        "hostHash": hashlib.sha256(
            MYSQL_HOST.encode("utf-8")
        ).hexdigest(),
        "databaseHash": hashlib.sha256(
            MYSQL_DATABASE.encode("utf-8")
        ).hexdigest(),
        "sessionTransactionReadOnly": True,
    },
    "scope": {
        "tenantHash": hashlib.sha256(
            str(TENANT_ID).encode("utf-8")
        ).hexdigest(),
        "panelId": str(PANEL_ID),
        "pageId": str(PAGE_ID),
        "usePageId": str(USE_PAGE_ID),
    },
    "usePage": use_page,
    "configFieldCount": len(config_fields),
    "useLayoutFieldCount": len(use_layout_fields),
    "useLayoutConditionCount": len(use_layout_conditions),
    "tenantNullSemanticConfiguration": {
        "fieldRows": global_field_null_semantics,
        "layoutFieldRows": global_layout_field_null_semantics,
        "layoutConditionRows": global_layout_condition_null_semantics,
        "totalRows": (
            len(global_field_null_semantics)
            + len(global_layout_field_null_semantics)
            + len(global_layout_condition_null_semantics)
        ),
    },
    "resolvedFieldCount": len(field_rows),
    "selectedFieldMatchCount": len(selected_field_rows),
    "selectedTableNames": selected_table_names,
    "selectedTableActiveRows": selected_table_counts,
    "tableScopedNullFieldCount": len(table_scoped_null_fields),
    "selectedFieldSemantics": [
        {
            "fieldId": str(row.get("id")),
            "fieldKey": row.get("field"),
            "fieldCode": row.get("field_code"),
            "whereExp": row.get("where_exp"),
            "fieldQualityTag": row.get("field_quality_tag"),
            "tableName": row.get("table_name"),
            "tableField": (
                row.get("table_script_field")
                or row.get("table_field")
            ),
        }
        for row in selected_field_rows
    ],
    "nullSemanticCandidateCount": len(candidates),
    "nullSemanticCandidates": candidates,
    "credentialsPersisted": False,
    "businessFieldValuesPersisted": False,
}
encoded = json.dumps(
    report,
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
    default=str,
).encode("utf-8")
report["reportHash"] = hashlib.sha256(encoded).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
