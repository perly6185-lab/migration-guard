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


def required_id(name: str) -> str:
    value = os.environ.get(name, "")
    if not value.isdigit():
        sys.exit(f"{name} must contain only digits")
    return value


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


use_page_id = required_id("MG_USE_PAGE_ID")
page_id = required_id("MG_PAGE_ID")
panel_id = required_id("MG_PANEL_ID")
inter_id = required_id("MG_INTER_ID")
http_id = required_id("MG_HTTP_ID")

binding = mysql_query(
    f"""
    SELECT
      u.id, u.page_id, u.page_name, u.tenant_id, u.deleted,
      p.id, p.name, p.pk_field_id, p.deleted,
      o.panel_id, o.id, o.deleted,
      h.id, h.panel_id, h.inter_id, h.request_method, h.remote_url, h.deleted,
      i.id, i.name, i.deleted
    FROM boss_view_dynamic_use_page_data u
    LEFT JOIN boss_view_dynamic_page_data p
      ON p.id = u.page_id AND p.tenant_id = u.tenant_id
    LEFT JOIN boss_view_dynamic_operational_data o
      ON o.page_id = p.id AND o.tenant_id = u.tenant_id
    LEFT JOIN boss_view_dynamic_http_data h
      ON h.id = {http_id} AND h.tenant_id = u.tenant_id
    LEFT JOIN boss_sql_dynamic_inter_data i
      ON i.id = {inter_id} AND i.tenant_id = u.tenant_id
    WHERE u.id = {use_page_id}
    """,
    [
        "usePageId",
        "resolvedPageId",
        "usePageName",
        "tenantId",
        "usePageDeleted",
        "pageId",
        "pageName",
        "pkFieldId",
        "pageDeleted",
        "panelId",
        "operationalId",
        "operationalDeleted",
        "httpId",
        "httpPanelId",
        "httpInterId",
        "requestMethod",
        "remoteUrl",
        "httpDeleted",
        "interId",
        "interName",
        "interDeleted",
    ],
)

child_forms = mysql_query(
    f"""
    SELECT
      f.id, f.name, f.field, f.child_form_use_page_id,
      cu.page_id, cu.page_name,
      co.panel_id, cp.name,
      COUNT(DISTINCT cf.id),
      GROUP_CONCAT(DISTINCT cf.table_name ORDER BY cf.table_name SEPARATOR ',')
    FROM boss_view_dynamic_field_data f
    JOIN boss_view_dynamic_use_page_data cu
      ON cu.id = f.child_form_use_page_id
     AND cu.tenant_id = f.tenant_id
     AND cu.deleted = 0
    JOIN boss_view_dynamic_operational_data co
      ON co.page_id = cu.page_id
     AND co.tenant_id = cu.tenant_id
     AND co.deleted = 0
    JOIN boss_view_dynamic_panel_data cp
      ON cp.id = co.panel_id
     AND cp.tenant_id = cu.tenant_id
     AND cp.deleted = 0
    LEFT JOIN boss_view_dynamic_field_data cf
      ON cf.panel_id = co.panel_id
     AND cf.tenant_id = cu.tenant_id
     AND cf.deleted = 0
    WHERE f.panel_id = {panel_id}
      AND f.tenant_id = (SELECT tenant_id FROM boss_view_dynamic_use_page_data WHERE id = {use_page_id})
      AND f.deleted = 0
      AND f.child_form_use_page_id IS NOT NULL
    GROUP BY
      f.id, f.name, f.field, f.child_form_use_page_id,
      cu.page_id, cu.page_name, co.panel_id, cp.name
    ORDER BY f.id
    """,
    [
        "parentFieldId",
        "parentFieldName",
        "parentFieldCode",
        "childUsePageId",
        "childPageId",
        "childPageName",
        "childPanelId",
        "childPanelName",
        "childFieldCount",
        "childPhysicalTables",
    ],
)

sync_configs = mysql_query(
    f"""
    SELECT stage, id, source_use_page_id, sync_use_page_id, status, released, deleted
    FROM (
      SELECT 'pipeline' AS stage, id, source_use_page_id, sync_use_page_id, status, released, deleted
      FROM boss_dynamic_data_sync_data
      WHERE sync_use_page_id = {use_page_id}
      UNION ALL
      SELECT 'relation', id, source_use_page_id, sync_use_page_id, status, released, deleted
      FROM boss_data_sync_relation_data
      WHERE sync_use_page_id = {use_page_id}
      UNION ALL
      SELECT 'split', id, source_use_page_id, sync_use_page_id, status, released, deleted
      FROM boss_data_sync_split_data
      WHERE sync_use_page_id = {use_page_id}
    ) configs
    ORDER BY stage, id
    """,
    [
        "stage",
        "configId",
        "sourceUsePageId",
        "syncUsePageId",
        "status",
        "released",
        "deleted",
    ],
)

selected_field_codes = [
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
quoted_codes = ", ".join("'" + code + "'" for code in selected_field_codes)
selected_fields = mysql_query(
    f"""
    SELECT field, id, name, field_type_value, table_name, table_field,
           field_read_only_tag, child_form_use_page_id
    FROM boss_view_dynamic_field_data
    WHERE panel_id = {panel_id}
      AND deleted = 0
      AND field IN ({quoted_codes})
    ORDER BY field
    """,
    [
        "fieldCode",
        "fieldId",
        "fieldName",
        "fieldType",
        "tableName",
        "tableField",
        "readOnly",
        "childUsePageId",
    ],
)

group_ids = [
    "2064532609377431553",
    "2064532694618271745",
    "2064532786414809090",
]
group_field_codes = ", ".join("'group_" + group_id + "'" for group_id in group_ids)
header_groups = mysql_query(
    f"""
    SELECT id, panel_id, name, field, field_type_value, header_group_id, tenant_id, deleted
    FROM boss_view_dynamic_field_data
    WHERE field IN ({group_field_codes})
    ORDER BY id
    """,
    [
        "groupId",
        "panelId",
        "groupName",
        "fieldCode",
        "fieldType",
        "parentHeaderGroupId",
        "tenantId",
        "deleted",
    ],
)

physical_names = {"cust_table6311"}
for child in child_forms:
    if child["childPhysicalTables"]:
        physical_names.update(str(child["childPhysicalTables"]).split(","))
quoted_tables = ", ".join("'" + name.replace("'", "''") + "'" for name in sorted(physical_names))
physical_tables = mysql_query(
    f"""
    SELECT table_name, table_rows
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ({quoted_tables})
    ORDER BY table_name
    """,
    ["tableName", "estimatedRows"],
)

expected = {
    "usePageId": use_page_id,
    "pageId": page_id,
    "panelId": panel_id,
    "interId": inter_id,
    "httpId": http_id,
}
actual = binding[0] if binding else {}
consistency = {
    key: actual.get(
        {
            "pageId": "resolvedPageId",
            "panelId": "panelId",
            "usePageId": "usePageId",
            "interId": "interId",
            "httpId": "httpId",
        }[key]
    )
    == value
    for key, value in expected.items()
}
consistency["httpPanelId"] = actual.get("httpPanelId") == panel_id
consistency["httpInterId"] = actual.get("httpInterId") == inter_id

print(
    json.dumps(
        {
            "schemaVersion": 1,
            "queryMode": "read-only-metadata",
            "expected": expected,
            "consistency": consistency,
            "binding": binding,
            "childForms": child_forms,
            "syncConfigs": sync_configs,
            "selectedFields": {
                "requestedDataFieldCount": len(selected_field_codes),
                "resolvedDataFieldCount": len(selected_fields),
                "fields": selected_fields,
                "requestedHeaderGroupCount": len(group_ids),
                "resolvedHeaderGroupCount": len(header_groups),
                "headerGroups": header_groups,
            },
            "physicalTables": physical_tables,
        },
        ensure_ascii=False,
        indent=2,
    )
)
