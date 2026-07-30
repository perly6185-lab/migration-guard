import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


BASE_URL = os.environ.get(
    "MG_JAVA_BASE_URL",
    "https://test.ia-gz.com/admin-api",
).rstrip("/")
LOGIN_BASE_URL = os.environ.get("MG_LOGIN_BASE_URL", BASE_URL).rstrip("/")
TENANT_ID = os.environ["MG_JAVA_TENANT_ID"]
TOKEN = os.environ.get("MG_JAVA_TOKEN")
LOGIN_USERNAME = os.environ.get("MG_LOGIN_USERNAME")
LOGIN_PASSWORD = os.environ.get("MG_LOGIN_PASSWORD")
PANEL_ID = "2059838046666665986"

SELECT_VALUES = {
    key: key
    for key in [
        "custField59622",
        "custField59967",
        "custField59623",
        "custField59624",
        "custField60040",
        "custField59625",
        "custField59627",
        "custField59714",
        "custField60100",
        "custField59715",
        "custField60101",
        "custField60102",
        "custField60103",
        "custField59940",
        "custField59941",
        "custField59942",
        "custField59633",
        "custField60172",
        "custField61017",
        "custField61018",
        "custField59634",
        "custField59635",
        "custField59943",
        "custField60106",
        "custField60218",
        "custField60105",
    ]
}

PAGE_BODY = {
    "pageNo": 1,
    "pageSize": 500,
    "interId": "2059838045928468482",
    "orderValues": [],
    "headerValues": {},
    "postValues": {},
    "panelId": PANEL_ID,
    "pageId": "2059838046687637506",
    "httpId": "2059838047035764738",
    "selectValues": SELECT_VALUES,
    "showArchived": False,
    "usePageId": "2059838047023181826",
    "skipSavePageSize": True,
}

REPORT_FILL_BODY = {
    "pageNo": 1,
    "pageSize": 100,
    "interId": "2075463578447917062",
    "orderValues": [
        {
            "fieldName": "custField64317",
            "direction": "ASC",
            "fieldId": "2079848643265212417",
        }
    ],
    "headerValues": {},
    "postValues": {},
    "panelId": "2075463586106716161",
    "pageId": "2075463586303848450",
    "httpId": "2075463589101449218",
    "selectValues": {
        key: key
        for key in [
            "custField64317",
            "custField64318",
            "custField64320",
            "custField64325",
            "custField64319",
            "custField64322",
            "custField64323",
        ]
    },
    "showArchived": False,
    "usePageId": "2075463589034340354",
    "skipSavePageSize": True,
}

QUALITY_PAGE_BODY = {
    **PAGE_BODY,
    "qualityValues": {
        "custField59622": True,
    },
}

CHILD_FORM_PAGE_BODY = {
    **PAGE_BODY,
    "dataId": "2064520897920167942",
    "childFormFieldId": "2064520806866022401",
}

REQUESTS = [
    (
        "page-metadata-query",
        "POST",
        "/zboss/data/view/dynamic/engine/use/engine-use-page/query",
        {"usePageId": "2059838047023181826"},
    ),
    (
        "standard-page-readonly",
        "POST",
        f"/zboss/data/view/dynamic/engine/use/engine-use-page/page?panelId={PANEL_ID}",
        PAGE_BODY,
    ),
    (
        "undo-status",
        "GET",
        f"/zboss/data/view-dynamic-data/undoStatus?panelId={PANEL_ID}",
        None,
    ),
    (
        "redo-status-diagnostic",
        "GET",
        f"/zboss/data/view-dynamic-data/redoStatus?panelId={PANEL_ID}",
        None,
    ),
    (
        "fill-metadata-query",
        "POST",
        "/zboss/data/view/dynamic/engine/use/engine-use-fill/query",
        {"usePageId": "2075463589034340354"},
    ),
    (
        "fill-page-readonly",
        "POST",
        "/zboss/data/view/dynamic/engine/use/engine-use-fill/page",
        REPORT_FILL_BODY,
    ),
    (
        "quality-null-page-readonly",
        "POST",
        f"/zboss/data/view/dynamic/engine/use/engine-use-page/page?panelId={PANEL_ID}",
        QUALITY_PAGE_BODY,
    ),
    (
        "child-form-page-readonly",
        "POST",
        f"/zboss/data/view/dynamic/engine/use/engine-use-page/page?panelId={PANEL_ID}",
        CHILD_FORM_PAGE_BODY,
    ),
]

REQUEST_FILTER = os.environ.get("MG_REQUEST_FILTER")


def resolve_token():
    if LOGIN_USERNAME and LOGIN_PASSWORD:
        body = {
            "username": LOGIN_USERNAME,
            "password": hashlib.md5(
                LOGIN_PASSWORD.encode("utf-8")
            ).hexdigest(),
            "loginType": 1,
        }
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{LOGIN_BASE_URL}/system/auth/login",
            data=payload,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "migration-guard-readonly-collector/1",
                "X-Device-Id": "migration-guard-readonly",
            },
        )
        with urllib.request.urlopen(
            request,
            timeout=30,
            context=ssl.create_default_context(),
        ) as response:
            parsed = json.loads(response.read())
        if parsed.get("code") != 0:
            raise RuntimeError(
                f"login failed: code={parsed.get('code')} "
                f"msg={parsed.get('msg')}"
            )
        data = parsed.get("data") or {}
        access_token = (
            data.get("accessToken")
            or data.get("access_token")
            or data.get("token")
        )
        if not access_token:
            raise RuntimeError("login succeeded without an access token")
        return f"Bearer {access_token}", "login"
    if TOKEN:
        return TOKEN, "environment"
    raise RuntimeError(
        "set MG_JAVA_TOKEN or MG_LOGIN_USERNAME/MG_LOGIN_PASSWORD"
    )


def value_shape(value, depth=0):
    if isinstance(value, dict):
        result = {
            "type": "object",
            "keys": sorted(value.keys()),
        }
        if depth < 2:
            result["children"] = {
                key: value_shape(item, depth + 1)
                for key, item in sorted(value.items())
            }
        return result
    if isinstance(value, list):
        result = {"type": "array", "length": len(value)}
        if value and depth < 2:
            result["firstItem"] = value_shape(value[0], depth + 1)
        return result
    return {"type": type(value).__name__}


def summarize(name, parsed):
    if not isinstance(parsed, dict):
        return {"jsonType": type(parsed).__name__}
    data = parsed.get("data")
    summary = {
        "code": parsed.get("code"),
        "msg": parsed.get("msg"),
        "dataType": type(data).__name__,
    }
    if name in {"page-metadata-query", "fill-metadata-query"} and isinstance(
        data, dict
    ):
        summary.update(
            {
                "usePageId": data.get("usePageId"),
                "layoutId": data.get("layoutId"),
                "viewId": data.get("viewId"),
                "panelCount": len(data.get("panelRespKeyList") or []),
                "panelDataCount": len(data.get("data") or {}),
                "valueSyncPanelCount": len(data.get("valueSyncStatusMap") or {}),
                "topLevelDataKeys": sorted(data.keys()),
            }
        )
    elif name in {
        "standard-page-readonly",
        "fill-page-readonly",
        "quality-null-page-readonly",
        "child-form-page-readonly",
    } and isinstance(data, dict):
        response_data = data.get("respData")
        summary.update(
            {
                "reqIdPresent": bool(data.get("reqId")),
                "topLevelDataKeys": sorted(data.keys()),
                "responseDataShape": value_shape(response_data),
                "headCount": len(data.get("headList") or []),
                "uploadTmpTableNamePresent": bool(
                    data.get("uploadTmpTableName")
                ),
            }
        )
    elif name in {"undo-status", "redo-status-diagnostic"}:
        summary["statusData"] = data
    return summary


def execute(token, name, method, path, body):
    payload = (
        json.dumps(body, separators=(",", ":")).encode("utf-8")
        if body is not None
        else None
    )
    request_hash = hashlib.sha256(payload or b"").hexdigest()
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=payload,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": token,
            "Content-Type": "application/json",
            "tenant-id": TENANT_ID,
            "User-Agent": "migration-guard-readonly-collector/1",
            "X-Device-Id": "migration-guard-readonly",
            "X-Request-Id": f"mg-ro-{name}-{int(time.time() * 1000)}",
        },
    )
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(
            request,
            timeout=30,
            context=ssl.create_default_context(),
        )
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    elapsed_ms = round((time.monotonic() - started) * 1000)
    try:
        parsed = json.loads(raw)
        json_valid = True
    except json.JSONDecodeError:
        parsed = None
        json_valid = False
    return {
        "name": name,
        "method": method,
        "path": path,
        "requestHash": request_hash,
        "httpStatus": response.status,
        "elapsedMs": elapsed_ms,
        "responseBytes": len(raw),
        "responseHash": hashlib.sha256(raw).hexdigest(),
        "contentType": response.headers.get("Content-Type"),
        "jsonValid": json_valid,
        "summary": summarize(name, parsed) if json_valid else None,
    }


resolved_token, auth_source = resolve_token()
report = {
    "schemaVersion": 1,
    "stage": "zboss-real-readonly-http-collection",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "baseUrl": BASE_URL,
    "tenantHash": hashlib.sha256(TENANT_ID.encode("utf-8")).hexdigest(),
    "authSource": auth_source,
    "credentialsPersisted": False,
    "mutatingEndpointsInvoked": False,
    "requests": [
        execute(resolved_token, *entry)
        for entry in REQUESTS
        if REQUEST_FILTER is None or entry[0] == REQUEST_FILTER
    ],
}
payload = json.dumps(report, sort_keys=True, separators=(",", ":")).encode(
    "utf-8"
)
report["reportHash"] = hashlib.sha256(payload).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2))
