import os
import subprocess
import urllib.request

import yaml


NACOS_CONFIG_URL = (
    "http://10.10.10.14:8848/nacos/v1/cs/configs"
    "?dataId=zboss-global-data-server-test.yaml"
    "&group=DEFAULT_GROUP&tenant=test"
)


def mysql_query(sql: str) -> str:
    with urllib.request.urlopen(NACOS_CONFIG_URL, timeout=10) as response:
        config = yaml.safe_load(response.read())
    datasource = config["zboss"]["datasource"]["dev"]
    database = datasource["url"].split("/", 3)[3].split("?", 1)[0]
    environment = dict(os.environ, MYSQL_PWD=str(datasource["password"]))
    result = subprocess.run(
        [
            "mysql",
            "--batch",
            "--raw",
            "--host",
            "10.10.10.14",
            "--port",
            "3306",
            "--user",
            str(datasource["username"]),
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
    return result.stdout


print(
    mysql_query(
        """
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'boss_view_dynamic_operational_data'
        ORDER BY ordinal_position
        """
    )
)

print(
    mysql_query(
        """
        SELECT
          u.tenant_id,
          u.id AS use_page_id,
          u.page_id,
          o.panel_id,
          p.pk_field_id,
          COUNT(f.id) AS field_count,
          MAX(CASE WHEN f.table_name IS NOT NULL THEN f.table_name END) AS table_name
        FROM boss_view_dynamic_use_page_data u
        JOIN boss_view_dynamic_operational_data o
          ON o.page_id = u.page_id
         AND o.tenant_id = u.tenant_id
         AND o.deleted = 0
        JOIN boss_view_dynamic_page_data p
          ON p.id = u.page_id
         AND p.tenant_id = u.tenant_id
         AND p.deleted = 0
        JOIN boss_view_dynamic_field_data f
          ON f.panel_id = o.panel_id
         AND f.tenant_id = u.tenant_id
         AND f.deleted = 0
        WHERE u.deleted = 0
          AND u.tenant_id > 0
        GROUP BY
          u.tenant_id, u.id, u.page_id, o.panel_id, p.pk_field_id
        HAVING field_count >= 2 AND table_name IS NOT NULL
        ORDER BY u.update_time DESC
        LIMIT 30
        """
    )
)
