"""Safety-aware collector for the ZBoss calendar query -> page workflow.

The default mode is plan-only and performs no network request.

Modes:
  plan             Print the execution/safety plan.
  page-readonly    Execute only /page after adding skipSavePageSize=true.
  workflow-observe Execute /query and the safe /page variant. This mode requires
                   explicit acknowledgement because /query may self-heal config.
"""

import copy
import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = (
    ROOT
    / "cases"
    / "zboss-page"
    / "fixtures"
    / "real-candidates"
    / "calendar-view"
)
QUERY = json.loads((FIXTURE_DIR / "query.json").read_text(encoding="utf-8"))
PAGE = json.loads((FIXTURE_DIR / "page.json").read_text(encoding="utf-8"))

BASE_URL = os.environ.get(
    "MG_JAVA_BASE_URL", "https://test.ia-gz.com/admin-api"
).rstrip("/")
LOGIN_BASE_URL = os.environ.get("MG_LOGIN_BASE_URL", BASE_URL).rstrip("/")
TOKEN = os.environ.get("MG_JAVA_TOKEN")
LOGIN_USERNAME = os.environ.get("MG_LOGIN_USERNAME")
LOGIN_PASSWORD = os.environ.get("MG_LOGIN_PASSWORD")
MODE = os.environ.get("MG_CALENDAR_PROBE_MODE", "plan")
QUERY_PATH = "/zboss/data/view/dynamic/engine/use/engine-use-page/query"
PAGE_PATH = "/zboss/data/view/dynamic/engine/use/engine-use-page/page"
VOLATILE_KEYS = {
    "reqId",
    "requestId",
    "traceId",
    "timestamp",
    "updateTime",
    "createTime",
}


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
                "User-Agent": "migration-guard-calendar-probe/1",
                "X-Device-Id": "migration-guard-calendar-probe",
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


def canonicalize(value):
    if isinstance(value, dict):
        return {
            key: canonicalize(item)
            for key, item in sorted(value.items())
            if key not in VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    return value


def digest_json(value):
    payload = json.dumps(
        canonicalize(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def shape(value, depth=0):
    if isinstance(value, dict):
        result = {"type": "object", "keys": sorted(value)}
        if depth < 2:
            result["children"] = {
                key: shape(item, depth + 1)
                for key, item in sorted(value.items())
            }
        return result
    if isinstance(value, list):
        result = {"type": "array", "length": len(value)}
        if value and depth < 2:
            result["firstItem"] = shape(value[0], depth + 1)
        return result
    return {"type": type(value).__name__}


def collect_named_values(value, names, result=None):
    if result is None:
        result = {name: [] for name in names}
    if isinstance(value, dict):
        for key, item in value.items():
            if key in result and item is not None:
                rendered = str(item)
                if rendered not in result[key]:
                    result[key].append(rendered)
            collect_named_values(item, names, result)
    elif isinstance(value, list):
        for item in value:
            collect_named_values(item, names, result)
    return result


def calendar_signals(value, result=None):
    if result is None:
        result = set()
    if isinstance(value, dict):
        for key, item in value.items():
            lowered = key.lower()
            if any(
                token in lowered
                for token in ("calendar", "startdate", "enddate", "allday")
            ):
                result.add(key)
            calendar_signals(item, result)
    elif isinstance(value, list):
        for item in value:
            calendar_signals(item, result)
    elif isinstance(value, str) and "calendar" in value.lower():
        result.add(value[:120])
    return sorted(result)


def execute(token, tenant_id, name, path, body):
    payload = json.dumps(
        body, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": token,
            "Content-Type": "application/json",
            "tenant-id": tenant_id,
            "User-Agent": "migration-guard-calendar-probe/1",
            "X-Device-Id": "migration-guard-calendar-probe",
            "X-Request-Id": f"mg-calendar-{name}-{int(time.time() * 1000)}",
        },
    )
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(
            request, timeout=60, context=ssl.create_default_context()
        )
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    elapsed_ms = round((time.monotonic() - started) * 1000)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None
    data = parsed.get("data") if isinstance(parsed, dict) else None
    return {
        "name": name,
        "path": path,
        "requestHash": digest_json(body),
        "httpStatus": response.status,
        "elapsedMs": elapsed_ms,
        "responseBytes": len(raw),
        "responseHash": hashlib.sha256(raw).hexdigest(),
        "canonicalResponseHash": (
            digest_json(parsed) if parsed is not None else None
        ),
        "businessCode": (
            parsed.get("code") if isinstance(parsed, dict) else None
        ),
        "jsonValid": parsed is not None,
        "responseShape": shape(parsed) if parsed is not None else None,
        "identityValues": (
            collect_named_values(
                data,
                {"usePageId", "viewId", "panelId", "pageId", "interId", "httpId"},
            )
            if data is not None
            else None
        ),
        "calendarSignals": calendar_signals(data) if data is not None else [],
    }


def execution_plan():
    return {
        "schemaVersion": 1,
        "stage": "zboss-calendar-view-probe-plan",
        "mode": MODE,
        "baseUrl": BASE_URL,
        "networkRequestPerformed": False,
        "exactQueryRequestHash": digest_json(QUERY),
        "exactPageRequestHash": digest_json(PAGE),
        "workflow": [
            {
                "path": QUERY_PATH,
                "risk": "query-time configuration self-healing may write MySQL",
                "defaultAllowed": False,
            },
            {
                "path": PAGE_PATH,
                "risk": "exact request may persist the page-size preference",
                "defaultAllowed": False,
                "safeVariant": "inject skipSavePageSize=true",
            },
        ],
        "declaredIdentity": {
            "usePageId": QUERY["usePageId"],
            "viewId": QUERY["viewId"],
            "panelId": PAGE["panelId"],
            "pageId": PAGE["pageId"],
            "interId": PAGE["interId"],
            "httpId": PAGE["httpId"],
        },
        "requiredExternalEvidence": [
            "SQL trace",
            "MySQL before/after snapshot",
            "calendar timezone and interval assertions",
        ],
    }


if MODE == "plan":
    print(json.dumps(execution_plan(), ensure_ascii=False, indent=2))
elif MODE not in {"page-readonly", "workflow-observe"}:
    raise RuntimeError(
        "MG_CALENDAR_PROBE_MODE must be plan, page-readonly, or workflow-observe"
    )
else:
    token, credential_source = resolve_token()
    tenant_id = os.environ["MG_JAVA_TENANT_ID"]
    if "operator" in PAGE:
        raise RuntimeError("calendar page probe refuses requests with operator")
    if int(PAGE.get("pageSize", 0)) > 10000:
        raise RuntimeError("calendar page probe refuses pageSize > 10000")

    safe_page = copy.deepcopy(PAGE)
    safe_page["skipSavePageSize"] = True
    results = []

    if MODE == "workflow-observe":
        if (
            os.environ.get("MG_ALLOW_QUERY_SELF_HEALING")
            != "I_UNDERSTAND_QUERY_MAY_WRITE"
        ):
            raise RuntimeError(
                "workflow-observe requires "
                "MG_ALLOW_QUERY_SELF_HEALING=I_UNDERSTAND_QUERY_MAY_WRITE"
            )
        if os.environ.get("MG_MYSQL_SNAPSHOT_CONFIRMED") != "1":
            raise RuntimeError(
                "workflow-observe requires MG_MYSQL_SNAPSHOT_CONFIRMED=1"
            )
        results.extend(
            execute(token, tenant_id, "calendar-query", QUERY_PATH, QUERY)
            for _ in range(2)
        )

    results.extend(
        execute(
            token,
            tenant_id,
            "calendar-page-readonly-variant",
            PAGE_PATH,
            safe_page,
        )
        for _ in range(2)
    )
    report = {
        "schemaVersion": 1,
        "stage": "zboss-calendar-view-observation",
        "collectedAt": datetime.now(timezone.utc).isoformat(),
        "mode": MODE,
        "baseUrl": BASE_URL,
        "credentialSource": credential_source,
        "credentialsPersisted": False,
        "rawResponsesPersisted": False,
        "exactPageRequestExecuted": False,
        "pageRequestModifiedForSafety": True,
        "queryMayHaveWritten": MODE == "workflow-observe",
        "sqlTraceCaptured": False,
        "mysqlSnapshotDeclared": (
            os.environ.get("MG_MYSQL_SNAPSHOT_CONFIRMED") == "1"
        ),
        "results": results,
    }
    report["repeatCanonicalHashesMatch"] = all(
        results[index]["canonicalResponseHash"]
        == results[index + 1]["canonicalResponseHash"]
        for index in range(0, len(results), 2)
    )
    report["reportHash"] = digest_json(report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
