import hashlib
import json
import os
import ssl
import time
import tracemalloc
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


BASE_URL = os.environ.get(
    "MG_JAVA_BASE_URL",
    "https://test.ia-gz.com/admin-api",
).rstrip("/")
LOGIN_BASE_URL = os.environ.get("MG_LOGIN_BASE_URL", BASE_URL).rstrip("/")
TENANT_ID = os.environ["MG_JAVA_TENANT_ID"]
TOKEN = os.environ.get("MG_JAVA_TOKEN")
LOGIN_USERNAME = os.environ.get("MG_LOGIN_USERNAME")
LOGIN_PASSWORD = os.environ.get("MG_LOGIN_PASSWORD")
REPEAT_COUNT = int(os.environ.get("MG_REPEAT_COUNT", "2"))
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("MG_REQUEST_TIMEOUT_SECONDS", "60"))
PATH = "/zboss/data/view/dynamic/engine/use/engine-use-horizontal/list"
REQUEST_FILE = (
    Path(__file__).resolve().parents[2]
    / "cases"
    / "zboss-horizontal-list"
    / "fixtures"
    / "real-candidates"
    / "provided-horizontal-list"
    / "request.json"
)


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
                "User-Agent": "migration-guard-horizontal-readonly/1",
                "X-Device-Id": "migration-guard-horizontal-readonly",
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


def validate_readonly_request(body):
    if body.get("operator") is not None:
        raise RuntimeError(
            "read-only collector refuses horizontal requests with operator"
        )
    if int(body.get("pageSize", 0)) > 10000:
        raise RuntimeError("read-only collector pageSize exceeds 10000")
    required = {
        "pageNo",
        "pageSize",
        "interId",
        "panelId",
        "pageId",
        "httpId",
        "selectValues",
    }
    missing = sorted(required.difference(body))
    if missing:
        raise RuntimeError(f"request is missing required fields: {missing}")
    if not body.get("horizontalId") and not body.get("usePageId"):
        raise RuntimeError("request requires horizontalId or derived usePageId")


def canonicalize(value):
    if isinstance(value, dict):
        return {
            key: canonicalize(item)
            for key, item in sorted(value.items())
            if key not in {"reqId", "requestId", "traceId"}
        }
    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    return value


def find_rows(value):
    rows = []
    if isinstance(value, list):
        if all(isinstance(item, dict) for item in value):
            rows.extend(value)
        for item in value:
            rows.extend(find_rows(item))
    elif isinstance(value, dict):
        for item in value.values():
            rows.extend(find_rows(item))
    return rows


def is_ascending(values):
    comparable = [value for value in values if value is not None]
    normalized = [
        (0, float(value))
        if isinstance(value, (int, float))
        else (1, str(value))
        for value in comparable
    ]
    return all(
        normalized[index] <= normalized[index + 1]
        for index in range(len(normalized) - 1)
    )


def summarize(parsed):
    if not isinstance(parsed, dict):
        return {"jsonType": type(parsed).__name__}
    data = parsed.get("data")
    resp_data = data.get("respData") if isinstance(data, dict) else None
    rows = find_rows(resp_data)
    ordered_values = [
        row.get("custField59623")
        for row in rows
        if "custField59623" in row
    ]
    selected_keys = [
        "custField59623",
        "custField60040_0",
        "custField60040_0|custField59627",
    ]
    return {
        "businessCode": parsed.get("code"),
        "messagePresent": bool(parsed.get("msg")),
        "dataType": type(data).__name__,
        "dataKeys": sorted(data.keys()) if isinstance(data, dict) else [],
        "responseGroupCount": len(resp_data)
        if isinstance(resp_data, dict)
        else None,
        "discoveredRowCount": len(rows),
        "orderedValueCount": len(ordered_values),
        "custField59623Ascending": is_ascending(ordered_values),
        "selectedFieldPresence": {
            key: sum(1 for row in rows if key in row)
            for key in selected_keys
        },
        "totalValues": sorted({
            item
            for item in collect_named_scalars(parsed, "total")
            if isinstance(item, (int, float))
        }),
    }


def collect_named_scalars(value, name, result=None):
    if result is None:
        result = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == name and not isinstance(item, (dict, list)):
                result.append(item)
            collect_named_scalars(item, name, result)
    elif isinstance(value, list):
        for item in value:
            collect_named_scalars(item, name, result)
    return result


def execute(token, body, variant, sequence):
    payload = json.dumps(
        body, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}{PATH}",
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": token,
            "Content-Type": "application/json",
            "tenant-id": TENANT_ID,
            "User-Agent": "migration-guard-horizontal-readonly/1",
            "X-Device-Id": "migration-guard-horizontal-readonly",
            "X-Request-Id": (
                f"mg-horizontal-ro-{variant}-{sequence}-"
                f"{int(time.time() * 1000)}"
            ),
        },
    )
    tracemalloc.start()
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(
            request,
            timeout=REQUEST_TIMEOUT_SECONDS,
            context=ssl.create_default_context(),
        )
    except urllib.error.HTTPError as error:
        response = error
    except (TimeoutError, urllib.error.URLError) as error:
        _, peak_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        return {
            "variant": variant,
            "sequence": sequence,
            "completed": False,
            "errorType": type(error).__name__,
            "elapsedMs": round((time.monotonic() - started) * 1000),
            "pythonPeakAllocatedBytes": peak_bytes,
            "rawResponsePersisted": False,
            "canonicalResponseHash": None,
        }
    raw = response.read()
    elapsed_ms = round((time.monotonic() - started) * 1000)
    try:
        parsed = json.loads(raw)
        json_valid = True
    except json.JSONDecodeError:
        parsed = None
        json_valid = False
    canonical = (
        json.dumps(
            canonicalize(parsed),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        if json_valid
        else raw
    )
    _, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        "variant": variant,
        "sequence": sequence,
        "completed": True,
        "httpStatus": response.status,
        "elapsedMs": elapsed_ms,
        "responseBytes": len(raw),
        "pythonPeakAllocatedBytes": peak_bytes,
        "responseHash": hashlib.sha256(raw).hexdigest(),
        "canonicalResponseHash": hashlib.sha256(canonical).hexdigest(),
        "contentType": response.headers.get("Content-Type"),
        "jsonValid": json_valid,
        "summary": summarize(parsed) if json_valid else None,
    }


body = json.loads(REQUEST_FILE.read_text(encoding="utf-8"))
validate_readonly_request(body)
token, credential_source = resolve_token()
horizontal_id = body["horizontalId"]
variants = {
    "supplied-false": dict(body),
    "derived-false": {
        **{key: value for key, value in body.items() if key != "horizontalId"},
        "usePageId": horizontal_id,
    },
    "supplied-omitted": {
        key: value for key, value in body.items() if key != "showArchived"
    },
    "supplied-true": {**body, "showArchived": True},
}
runs = []
for variant, variant_body in variants.items():
    validate_readonly_request(variant_body)
    for sequence in range(REPEAT_COUNT):
        runs.append(execute(
            token,
            variant_body,
            variant,
            sequence + 1,
        ))


def first_hash(variant):
    return next(
        item["canonicalResponseHash"]
        for item in runs
        if item["variant"] == variant
    )


variant_hashes = {
    variant: first_hash(variant)
    for variant in variants
}
variant_completed = {
    variant: all(
        item["completed"]
        for item in runs
        if item["variant"] == variant
    )
    for variant in variants
}
report = {
    "schemaVersion": 1,
    "stage": "zboss-horizontal-list-real-readonly",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "baseUrl": BASE_URL,
    "credentialSource": credential_source,
    "path": PATH,
    "requestHashes": {
        variant: hashlib.sha256(
            json.dumps(
                variant_body,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        for variant, variant_body in variants.items()
    },
    "tenantHash": hashlib.sha256(TENANT_ID.encode("utf-8")).hexdigest(),
    "credentialsPersisted": False,
    "rawResponsesPersisted": False,
    "mutatingEndpointsInvoked": False,
    "operatorAbsent": body.get("operator") is None,
    "sqlTraceCaptured": False,
    "runs": runs,
    "repeatCanonicalHashMatches": {
        variant: variant_completed[variant] and len({
            item["canonicalResponseHash"]
            for item in runs
            if item["variant"] == variant
        }) == 1
        for variant in variants
    },
    "compatibilityComparisons": {
        "suppliedDerivedParity": (
            variant_completed["supplied-false"]
            and variant_completed["derived-false"]
            and
            variant_hashes["supplied-false"]
            == variant_hashes["derived-false"]
        ),
        "showArchivedIgnored": (
            all(variant_completed[variant] for variant in (
                "supplied-false",
                "supplied-omitted",
                "supplied-true",
            ))
            and len({
                variant_hashes["supplied-false"],
                variant_hashes["supplied-omitted"],
                variant_hashes["supplied-true"],
            }) == 1
        ),
    },
}
report_payload = json.dumps(
    report, sort_keys=True, separators=(",", ":")
).encode("utf-8")
report["reportHash"] = hashlib.sha256(report_payload).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2))
