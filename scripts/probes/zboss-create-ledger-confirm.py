import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


BASE_URL = os.environ.get(
    "MG_JAVA_BASE_URL",
    "https://test.ia-gz.com/admin-api",
).rstrip("/")
TENANT_ID = os.environ["MG_JAVA_TENANT_ID"]
LOGIN_USERNAME = os.environ["MG_LOGIN_USERNAME"]
LOGIN_PASSWORD = os.environ["MG_LOGIN_PASSWORD"]
ANALYZE_TOKEN = os.environ["MG_ANALYZE_TOKEN"]
MODE = os.environ.get("MG_CONFIRM_MODE", "preflight").lower()

EXPECTED_FILE_NAME = os.environ.get(
    "MG_EXPECTED_FILE_NAME",
    "addBlankTemplate.xlsx",
)
EXPECTED_FILE_SIZE = int(os.environ.get("MG_EXPECTED_FILE_SIZE", "9056"))
EXPECTED_SHEET_NAME = os.environ.get("MG_EXPECTED_SHEET_NAME", "新建空表")
EXPECTED_ROW_COUNT = int(os.environ.get("MG_EXPECTED_ROW_COUNT", "4"))
EXPECTED_TOTAL_COLS = int(os.environ.get("MG_EXPECTED_TOTAL_COLS", "2"))

ENDPOINT_PREFIX = (
    "/zboss/data/view-dynamic-use-group-data/create-ledger-import"
)
TERMINAL_STATUSES = {"SUCCESS", "FAILED", "CANCELLED"}


def request_json(request, timeout=60):
    started = time.monotonic()
    try:
        with urllib.request.urlopen(
            request,
            timeout=timeout,
            context=ssl.create_default_context(),
        ) as response:
            raw = response.read()
            status = response.status
            content_type = response.headers.get("Content-Type")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
        content_type = exc.headers.get("Content-Type")
    parsed = json.loads(raw)
    return {
        "status": status,
        "contentType": content_type,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "raw": raw,
        "json": parsed,
    }


def login():
    body = {
        "username": LOGIN_USERNAME,
        "password": hashlib.md5(
            LOGIN_PASSWORD.encode("utf-8")
        ).hexdigest(),
        "loginType": 1,
    }
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    result = request_json(
        urllib.request.Request(
            f"{BASE_URL}/system/auth/login",
            data=payload,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "migration-guard-ledger-confirm/1",
                "X-Device-Id": "migration-guard-confirm",
            },
        )
    )
    if result["json"].get("code") != 0:
        raise RuntimeError(
            f"login failed: code={result['json'].get('code')} "
            f"msg={result['json'].get('msg')}"
        )
    data = result["json"].get("data") or {}
    token = (
        data.get("accessToken")
        or data.get("access_token")
        or data.get("token")
    )
    if not token:
        raise RuntimeError("login succeeded without access token")
    return f"Bearer {token}"


def common_headers(authorization):
    return {
        "Accept": "application/json",
        "Authorization": authorization,
        "tenant-id": TENANT_ID,
        "User-Agent": "migration-guard-ledger-confirm/1",
        "X-Device-Id": "migration-guard-confirm",
    }


def get_json(path, authorization):
    return request_json(
        urllib.request.Request(
            f"{BASE_URL}{path}",
            method="GET",
            headers=common_headers(authorization),
        )
    )


def session_readback(authorization):
    query = urllib.parse.urlencode({"analyzeToken": ANALYZE_TOKEN})
    return get_json(
        f"{ENDPOINT_PREFIX}/analyze/session?{query}",
        authorization,
    )


def flatten_columns(columns):
    result = []
    for column in columns or []:
        result.append(column)
        result.extend(flatten_columns(column.get("children") or []))
    return result


def validate_session(session_result):
    payload = session_result["json"]
    data = payload.get("data") or {}
    sheets = data.get("sheets") or []
    selected = next(
        (
            sheet
            for sheet in sheets
            if sheet.get("rawSheetName") == EXPECTED_SHEET_NAME
        ),
        None,
    )
    columns = flatten_columns((selected or {}).get("columns") or [])
    indices = sorted(
        column.get("colIndex")
        for column in columns
        if isinstance(column.get("colIndex"), int)
    )
    checks = {
        "httpStatus200": session_result["status"] == 200,
        "businessCode0": payload.get("code") == 0,
        "tokenMatches": data.get("analyzeToken") == ANALYZE_TOKEN,
        "fileNameMatches": data.get("fileName") == EXPECTED_FILE_NAME,
        "fileSizeMatches": data.get("fileSize") == EXPECTED_FILE_SIZE,
        "sheetFound": selected is not None,
        "rowCountMatches": (
            selected is not None
            and selected.get("rowCount") == EXPECTED_ROW_COUNT
        ),
        "totalColsMatches": (
            selected is not None
            and selected.get("totalCols") == EXPECTED_TOTAL_COLS
        ),
        "columnIndicesMatch": indices == [0, 1],
        "expireAtPresent": bool(data.get("expireAt")),
    }
    return {
        "valid": all(checks.values()),
        "checks": checks,
        "data": data,
        "selected": selected,
        "columnIndices": indices,
    }


def safe_session_summary(session_result, validated):
    payload = session_result["json"]
    data = validated["data"]
    selected = validated["selected"] or {}
    return {
        "httpStatus": session_result["status"],
        "businessCode": payload.get("code"),
        "elapsedMs": session_result["elapsedMs"],
        "responseBytes": len(session_result["raw"]),
        "responseHash": hashlib.sha256(
            session_result["raw"]
        ).hexdigest(),
        "tokenHash": hashlib.sha256(
            ANALYZE_TOKEN.encode("utf-8")
        ).hexdigest(),
        "fileId": data.get("fileId"),
        "fileName": data.get("fileName"),
        "fileSize": data.get("fileSize"),
        "expireAt": data.get("expireAt"),
        "sheetCount": len(data.get("sheets") or []),
        "selectedSheet": {
            "rawSheetName": selected.get("rawSheetName"),
            "sheetOrder": selected.get("sheetOrder"),
            "headerRow": selected.get("headerRow"),
            "rowCount": selected.get("rowCount"),
            "totalCols": selected.get("totalCols"),
            "warningCols": selected.get("warningCols"),
            "columnIndices": validated["columnIndices"],
        },
        "validation": validated["checks"],
        "valid": validated["valid"],
    }


def confirm_once(authorization):
    body = {
        "analyzeToken": ANALYZE_TOKEN,
        "sheets": [
            {
                "rawSheetName": EXPECTED_SHEET_NAME,
                "enabled": True,
                "columnOverrides": [
                    {
                        "colIndex": 0,
                        "fieldTagInnerKey": "text",
                        "fieldTypeValue": "text",
                        "ignored": False,
                        "groupPath": [],
                    },
                    {
                        "colIndex": 1,
                        "fieldTagInnerKey": "int",
                        "fieldTypeValue": "int",
                        "ignored": False,
                        "groupPath": [],
                    },
                ],
                "customName": EXPECTED_SHEET_NAME,
            }
        ],
    }
    payload = json.dumps(
        body,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return request_json(
        urllib.request.Request(
            f"{BASE_URL}{ENDPOINT_PREFIX}/confirm",
            data=payload,
            method="POST",
            headers={
                **common_headers(authorization),
                "Content-Type": "application/json",
            },
        ),
        timeout=90,
    )


def summarize_confirm(result):
    payload = result["json"]
    data = payload.get("data") or {}
    return {
        "httpStatus": result["status"],
        "businessCode": payload.get("code"),
        "message": payload.get("msg"),
        "elapsedMs": result["elapsedMs"],
        "responseBytes": len(result["raw"]),
        "responseHash": hashlib.sha256(result["raw"]).hexdigest(),
        "batchId": data.get("batchId"),
        "taskId": data.get("taskId"),
        "totalSheetCount": data.get("totalSheetCount"),
        "totalRows": data.get("totalRows"),
        "sheets": [
            {
                "rawSheetName": sheet.get("rawSheetName"),
                "sheetOrder": sheet.get("sheetOrder"),
                "rowCount": sheet.get("rowCount"),
                "status": sheet.get("status"),
            }
            for sheet in data.get("sheets") or []
        ],
    }


def summarize_status(result):
    payload = result["json"]
    data = payload.get("data") or {}
    return {
        "httpStatus": result["status"],
        "businessCode": payload.get("code"),
        "batchId": data.get("batchId"),
        "taskId": data.get("taskId"),
        "taskStatus": data.get("taskStatus"),
        "currentPhase": data.get("currentPhase"),
        "currentSheetName": data.get("currentSheetName"),
        "currentSheetIndex": data.get("currentSheetIndex"),
        "totalSheetCount": data.get("totalSheetCount"),
        "completedSheetCount": data.get("completedSheetCount"),
        "totalRows": data.get("totalRows"),
        "processedRows": data.get("processedRows"),
        "progressPercent": data.get("progressPercent"),
        "message": data.get("message"),
        "errorMsg": data.get("errorMsg"),
        "successCount": data.get("successCount"),
        "errorCount": data.get("errorCount"),
        "insertCount": data.get("insertCount"),
        "updateCount": data.get("updateCount"),
        "skipCount": data.get("skipCount"),
        "path": data.get("path"),
        "canCancel": data.get("canCancel"),
        "canRetry": data.get("canRetry"),
        "sheets": [
            {
                "rawSheetName": sheet.get("rawSheetName"),
                "status": sheet.get("status"),
                "ledgerName": sheet.get("ledgerName"),
                "path": sheet.get("path"),
                "usePageId": sheet.get("usePageId"),
                "pageId": sheet.get("pageId"),
                "rowCount": sheet.get("rowCount"),
                "processedRows": sheet.get("processedRows"),
                "successCount": sheet.get("successCount"),
                "errorCount": sheet.get("errorCount"),
                "insertCount": sheet.get("insertCount"),
                "updateCount": sheet.get("updateCount"),
                "skipCount": sheet.get("skipCount"),
                "message": sheet.get("message"),
            }
            for sheet in data.get("sheets") or []
        ],
    }


def summarize_history(result):
    payload = result["json"]
    data = payload.get("data") or {}
    return {
        "httpStatus": result["status"],
        "businessCode": payload.get("code"),
        "id": data.get("id"),
        "batchId": data.get("batchId"),
        "fileId": data.get("fileId"),
        "fileName": data.get("fileName"),
        "menuId": data.get("menuId"),
        "parentPath": data.get("parentPath"),
        "taskStatus": data.get("taskStatus"),
        "currentPhase": data.get("currentPhase"),
        "totalRows": data.get("totalRows"),
        "processedRows": data.get("processedRows"),
        "progressPercent": data.get("progressPercent"),
        "totalSheetCount": data.get("totalSheetCount"),
        "completedSheetCount": data.get("completedSheetCount"),
        "successCount": data.get("successCount"),
        "errorCount": data.get("errorCount"),
        "insertCount": data.get("insertCount"),
        "updateCount": data.get("updateCount"),
        "skipCount": data.get("skipCount"),
        "errorMsg": data.get("errorMsg"),
        "message": data.get("message"),
        "costMs": data.get("costMs"),
        "createTime": data.get("createTime"),
        "updateTime": data.get("updateTime"),
        "sheets": [
            {
                "sheetName": sheet.get("sheetName"),
                "sheetOrder": sheet.get("sheetOrder"),
                "ledgerName": sheet.get("ledgerName"),
                "path": sheet.get("path"),
                "usePageId": sheet.get("usePageId"),
                "pageId": sheet.get("pageId"),
                "taskStatus": sheet.get("taskStatus"),
                "rowCount": sheet.get("rowCount"),
                "processedRows": sheet.get("processedRows"),
                "successCount": sheet.get("successCount"),
                "errorCount": sheet.get("errorCount"),
                "insertCount": sheet.get("insertCount"),
                "updateCount": sheet.get("updateCount"),
                "skipCount": sheet.get("skipCount"),
                "errorMsg": sheet.get("errorMsg"),
                "message": sheet.get("message"),
            }
            for sheet in data.get("sheets") or []
        ],
    }


def poll_status(batch_id, authorization):
    deadline = time.monotonic() + int(
        os.environ.get("MG_CONFIRM_POLL_SECONDS", "90")
    )
    observations = []
    last = None
    while time.monotonic() < deadline:
        result = get_json(
            f"{ENDPOINT_PREFIX}/batch/{batch_id}/status",
            authorization,
        )
        last = summarize_status(result)
        signature = (
            last.get("taskStatus"),
            last.get("currentPhase"),
            last.get("progressPercent"),
            last.get("processedRows"),
        )
        if not observations or observations[-1]["signature"] != signature:
            observations.append(
                {
                    "atMs": int(time.time() * 1000),
                    "signature": signature,
                }
            )
        if last.get("taskStatus") in TERMINAL_STATUSES:
            break
        time.sleep(0.75)
    return last, observations


authorization = login()
session_result = session_readback(authorization)
validated = validate_session(session_result)
report = {
    "schemaVersion": 1,
    "stage": "zboss-create-ledger-confirm-preflight",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "baseUrl": BASE_URL,
    "tenantHash": hashlib.sha256(TENANT_ID.encode("utf-8")).hexdigest(),
    "mode": MODE,
    "session": safe_session_summary(session_result, validated),
    "confirmInvoked": False,
    "credentialsPersisted": False,
    "rawResponsesPersisted": False,
}

if MODE == "execute":
    if os.environ.get("MG_CONFIRM_ACK") != "CONFIRM_ONCE":
        raise RuntimeError(
            "execute mode requires MG_CONFIRM_ACK=CONFIRM_ONCE"
        )
    if not validated["valid"]:
        raise RuntimeError("session validation failed; confirm not invoked")
    confirm_result = confirm_once(authorization)
    report["confirmInvoked"] = True
    report["stage"] = "zboss-create-ledger-confirm-execution"
    report["confirm"] = summarize_confirm(confirm_result)
    confirm_data = confirm_result["json"].get("data") or {}
    batch_id = confirm_data.get("batchId")
    if (
        confirm_result["status"] != 200
        or confirm_result["json"].get("code") != 0
        or batch_id is None
    ):
        report["terminalStatusObserved"] = False
    else:
        terminal, observations = poll_status(batch_id, authorization)
        report["statusObservations"] = observations
        report["terminal"] = terminal
        report["terminalStatusObserved"] = (
            terminal is not None
            and terminal.get("taskStatus") in TERMINAL_STATUSES
        )
elif MODE == "observe":
    batch_id = int(os.environ["MG_BATCH_ID"])
    status_result = get_json(
        f"{ENDPOINT_PREFIX}/batch/{batch_id}/status",
        authorization,
    )
    history_result = get_json(
        f"{ENDPOINT_PREFIX}/history/{batch_id}",
        authorization,
    )
    report["stage"] = "zboss-create-ledger-confirm-observation"
    report["status"] = summarize_status(status_result)
    report["history"] = summarize_history(history_result)
    report["existingBatchObserved"] = True

encoded = json.dumps(
    report,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
report["reportHash"] = hashlib.sha256(encoded).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2))
