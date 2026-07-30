import json
import os
import subprocess
import sys
import urllib.request

import yaml


NACOS_CONFIG_URL = (
    "http://10.10.10.14:8848/nacos/v1/cs/configs"
    "?dataId=zboss-global-data-server-test.yaml"
    "&group=DEFAULT_GROUP&tenant=test"
)


def mysql_query(sql: str, columns: list[str]) -> list[dict[str, str | None]]:
    with urllib.request.urlopen(NACOS_CONFIG_URL, timeout=10) as response:
        config = yaml.safe_load(response.read())
    source = config["zboss"]["datasource"]["dev"]
    database = source["url"].split("/", 3)[3].split("?", 1)[0]
    environment = dict(os.environ, MYSQL_PWD=str(source["password"]))
    result = subprocess.run(
        [
            "mysql",
            "--batch",
            "--raw",
            "--skip-column-names",
            "--host",
            "10.10.10.14",
            "--port",
            "3306",
            "--user",
            str(source["username"]),
            "--database",
            database,
            "--execute",
            sql,
        ],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    rows = []
    for line in result.stdout.splitlines():
        values = [None if value == "NULL" else value for value in line.split("\t")]
        rows.append(dict(zip(columns, values, strict=True)))
    return rows


panel_id = os.environ.get("MG_PANEL_ID", "")
if not panel_id.isdigit():
    sys.exit("MG_PANEL_ID must contain only digits")

bindings = mysql_query(
    f"""
    SELECT
      p.id,
      p.name,
      p.tenant_id,
      p.deleted,
      o.id,
      o.page_id,
      d.name,
      d.pk_field_id,
      u.id,
      u.page_name,
      u.deleted
    FROM boss_view_dynamic_panel_data p
    LEFT JOIN boss_view_dynamic_operational_data o
      ON o.panel_id = p.id
     AND o.tenant_id = p.tenant_id
     AND o.deleted = 0
    LEFT JOIN boss_view_dynamic_page_data d
      ON d.id = o.page_id
     AND d.tenant_id = p.tenant_id
     AND d.deleted = 0
    LEFT JOIN boss_view_dynamic_use_page_data u
      ON u.page_id = o.page_id
     AND u.tenant_id = p.tenant_id
    WHERE p.id = {panel_id}
    ORDER BY u.deleted, u.update_time DESC
    """,
    [
        "panelId",
        "panelName",
        "tenantId",
        "panelDeleted",
        "operationalId",
        "pageId",
        "pageName",
        "pkFieldId",
        "usePageId",
        "usePageName",
        "usePageDeleted",
    ],
)

field_summary = mysql_query(
    f"""
    SELECT
      COUNT(*),
      COUNT(DISTINCT table_name),
      GROUP_CONCAT(DISTINCT table_name ORDER BY table_name SEPARATOR ','),
      SUM(CASE WHEN table_name IS NOT NULL AND table_field IS NOT NULL THEN 1 ELSE 0 END),
      SUM(CASE WHEN field_read_only_tag = 1 THEN 1 ELSE 0 END)
    FROM boss_view_dynamic_field_data
    WHERE panel_id = {panel_id}
      AND deleted = 0
    """,
    [
        "fieldCount",
        "physicalTableCount",
        "physicalTables",
        "mappedFieldCount",
        "readOnlyFieldCount",
    ],
)

horizontal_summary = mysql_query(
    f"""
    SELECT
      COUNT(*),
      COUNT(DISTINCT use_page_id),
      GROUP_CONCAT(DISTINCT use_page_id ORDER BY use_page_id SEPARATOR ','),
      GROUP_CONCAT(DISTINCT table_name ORDER BY table_name SEPARATOR ',')
    FROM boss_view_dynamic_horizontal_data
    WHERE panel_id = {panel_id}
      AND deleted = 0
    """,
    [
        "horizontalCount",
        "horizontalUsePageCount",
        "horizontalUsePageIds",
        "horizontalTables",
    ],
)

table_names = []
if field_summary and field_summary[0]["physicalTables"]:
    table_names = str(field_summary[0]["physicalTables"]).split(",")
escaped_tables = ", ".join("'" + name.replace("'", "''") + "'" for name in table_names)
physical_tables = (
    mysql_query(
        f"""
        SELECT table_name, table_rows
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN ({escaped_tables})
        ORDER BY table_name
        """,
        ["tableName", "estimatedRows"],
    )
    if escaped_tables
    else []
)

print(
    json.dumps(
        {
            "schemaVersion": 1,
            "panelId": panel_id,
            "queryMode": "read-only-metadata",
            "bindings": bindings,
            "fieldSummary": field_summary[0] if field_summary else None,
            "horizontalSummary": horizontal_summary[0] if horizontal_summary else None,
            "physicalTables": physical_tables,
        },
        ensure_ascii=False,
        indent=2,
    )
)
