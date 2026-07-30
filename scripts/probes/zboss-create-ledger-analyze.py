import hashlib
import json
import mimetypes
import os
import ssl
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path


BASE_URL = os.environ.get(
    "MG_JAVA_BASE_URL",
    "https://test.ia-gz.com/admin-api",
).rstrip("/")
TENANT_ID = os.environ["MG_JAVA_TENANT_ID"]
LOGIN_USERNAME = os.environ["MG_LOGIN_USERNAME"]
LOGIN_PASSWORD = os.environ["MG_LOGIN_PASSWORD"]
UPLOAD_FILE = Path(os.environ["MG_UPLOAD_FILE"])
MENU_ID = os.environ["MG_MENU_ID"]
UPDATE_SUPPORT = os.environ.get("MG_UPDATE_SUPPORT", "true")


def request_json(request):
    started = time.monotonic()
    with urllib.request.urlopen(
        request,
        timeout=60,
        context=ssl.create_default_context(),
    ) as response:
        raw = response.read()
        status = response.status
        content_type = response.headers.get("Content-Type")
    return {
        "status": status,
        "contentType": content_type,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "raw": raw,
        "json": json.loads(raw),
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
                "User-Agent": "migration-guard-upload-analyze/1",
                "X-Device-Id": "migration-guard-readonly",
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


def multipart_payload():
    boundary = f"----migration-guard-{uuid.uuid4().hex}"
    chunks = []

    def field(name, value):
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{name}"'
                    "\r\n\r\n"
                ).encode(),
                str(value).encode(),
                b"\r\n",
            ]
        )

    field("menuId", MENU_ID)
    field("updateSupport", UPDATE_SUPPORT)
    content_type = (
        mimetypes.guess_type(UPLOAD_FILE.name)[0]
        or "application/octet-stream"
    )
    chunks.extend(
        [
            f"--{boundary}\r\n".encode(),
            (
                'Content-Disposition: form-data; name="file"; '
                f'filename="{UPLOAD_FILE.name}"\r\n'
            ).encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            UPLOAD_FILE.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    return boundary, b"".join(chunks)


def summarize_analyze(data):
    sheets = data.get("sheets") or []
    return {
        "analyzeTokenPresent": bool(data.get("analyzeToken")),
        "analyzeTokenHash": hashlib.sha256(
            str(data.get("analyzeToken")).encode("utf-8")
        ).hexdigest()
        if data.get("analyzeToken")
        else None,
        "fileIdPresent": data.get("fileId") is not None,
        "fileName": data.get("fileName"),
        "fileSize": data.get("fileSize"),
        "sheetCount": data.get("sheetCount"),
        "totalRows": data.get("totalRows"),
        "estimatedSeconds": data.get("estimatedSeconds"),
        "sheets": [
            {
                "sheetOrder": sheet.get("sheetOrder"),
                "headerRow": sheet.get("headerRow"),
                "rowCount": sheet.get("rowCount"),
                "totalCols": sheet.get("totalCols"),
                "warningCols": sheet.get("warningCols"),
                "rootColumnCount": len(sheet.get("columns") or []),
            }
            for sheet in sheets
        ],
    }


token = login()
boundary, payload = multipart_payload()
common_headers = {
    "Accept": "application/json",
    "Authorization": token,
    "tenant-id": TENANT_ID,
    "User-Agent": "migration-guard-upload-analyze/1",
    "X-Device-Id": "migration-guard-readonly",
}
analyze = request_json(
    urllib.request.Request(
        (
            f"{BASE_URL}/zboss/data/view-dynamic-use-group-data/"
            "create-ledger-import/analyze"
        ),
        data=payload,
        method="POST",
        headers={
            **common_headers,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
)
analyze_json = analyze["json"]
if analyze_json.get("code") != 0:
    raise RuntimeError(
        f"analyze failed: code={analyze_json.get('code')} "
        f"msg={analyze_json.get('msg')}"
    )
analyze_data = analyze_json.get("data") or {}
analyze_token = analyze_data.get("analyzeToken")
if not analyze_token:
    raise RuntimeError("analyze succeeded without analyzeToken")

session_path = (
    "/zboss/data/view-dynamic-use-group-data/"
    "create-ledger-import/analyze/session?"
    + urllib.parse.urlencode({"analyzeToken": analyze_token})
)
session = request_json(
    urllib.request.Request(
        f"{BASE_URL}{session_path}",
        method="GET",
        headers=common_headers,
    )
)
session_json = session["json"]

report = {
    "schemaVersion": 1,
    "stage": "zboss-create-ledger-analyze-collection",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "baseUrl": BASE_URL,
    "tenantHash": hashlib.sha256(TENANT_ID.encode("utf-8")).hexdigest(),
    "input": {
        "fileName": UPLOAD_FILE.name,
        "fileSize": UPLOAD_FILE.stat().st_size,
        "fileHash": hashlib.sha256(UPLOAD_FILE.read_bytes()).hexdigest(),
        "menuIdHash": hashlib.sha256(MENU_ID.encode("utf-8")).hexdigest(),
        "updateSupport": UPDATE_SUPPORT.lower() == "true",
    },
    "analyze": {
        "httpStatus": analyze["status"],
        "businessCode": analyze_json.get("code"),
        "elapsedMs": analyze["elapsedMs"],
        "responseBytes": len(analyze["raw"]),
        "responseHash": hashlib.sha256(analyze["raw"]).hexdigest(),
        "summary": summarize_analyze(analyze_data),
    },
    "sessionReadback": {
        "httpStatus": session["status"],
        "businessCode": session_json.get("code"),
        "elapsedMs": session["elapsedMs"],
        "responseBytes": len(session["raw"]),
        "responseHash": hashlib.sha256(session["raw"]).hexdigest(),
        "tokenMatches": (
            (session_json.get("data") or {}).get("analyzeToken")
            == analyze_token
        ),
        "sheetCount": len(
            (session_json.get("data") or {}).get("sheets") or []
        ),
        "expireAtPresent": bool(
            (session_json.get("data") or {}).get("expireAt")
        ),
    },
    "sideEffects": {
        "sourceFileSaved": True,
        "redisAnalyzeSessionCreated": True,
        "mysqlTemporaryTableCreated": False,
        "confirmImportInvoked": False,
        "sessionTtlHours": 2,
    },
    "credentialsPersisted": False,
    "rawResponsesPersisted": False,
}
encoded = json.dumps(
    report,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
report["reportHash"] = hashlib.sha256(encoded).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2))
