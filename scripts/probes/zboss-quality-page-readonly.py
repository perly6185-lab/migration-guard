import hashlib
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


BASE_URL = os.environ.get(
    "MG_JAVA_BASE_URL",
    "https://test.ia-gz.com/admin-api",
).rstrip("/")
TENANT_ID = os.environ["MG_JAVA_TENANT_ID"]
LOGIN_USERNAME = os.environ["MG_LOGIN_USERNAME"]
LOGIN_PASSWORD = os.environ["MG_LOGIN_PASSWORD"]

PANEL_ID = "2059838081856876546"
USE_PAGE_ID = "2059838082205003777"

PAGE_BODY = {
    "pageNo": 1,
    "pageSize": 1000,
    "interId": "2059838081038987266",
    "orderValues": [],
    "headerValues": {},
    "postValues": {},
    "panelId": PANEL_ID,
    "pageId": "2059838081877848066",
    "httpId": "2059838082217586690",
    "selectValues": {
        key: key
        for key in [
            "custField60047",
            "custField60048",
            "custField60049",
            "custField60050",
            "custField60051",
            "custField60073",
            "custField60173",
            "custField60072",
            "group_2064532609377431553",
            "custField60046",
            "custField60064",
            "group_2064532694618271745",
            "custField60045",
            "custField60065",
            "group_2064532786414809090",
            "custField60066",
            "custField60067",
            "custField60052",
        ]
    },
    "showArchived": False,
    "usePageId": USE_PAGE_ID,
    "skipSavePageSize": True,
}

SAFE_CONDITION_KEYS = {
    "id",
    "fieldId",
    "fieldName",
    "field",
    "fieldCode",
    "tableName",
    "tableField",
    "name",
    "fieldComment",
    "whereExp",
    "whereExpValue",
    "whereExpCode",
}
VOLATILE_KEYS = {
    "reqId",
    "requestId",
    "traceId",
    "timestamp",
    "startTime",
    "endTime",
}


def request_json(token, method, path, body):
    payload = (
        json.dumps(
            body,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if body is not None
        else None
    )
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=payload,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": token,
            "Content-Type": "application/json",
            "tenant-id": TENANT_ID,
            "User-Agent": "migration-guard-quality-readonly/1",
            "X-Device-Id": "migration-guard-readonly",
            "X-Request-Id": f"mg-quality-ro-{int(time.time() * 1000)}",
        },
    )
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(
            request,
            timeout=60,
            context=ssl.create_default_context(),
        )
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    parsed = json.loads(raw)
    return {
        "status": response.status,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "raw": raw,
        "json": parsed,
        "requestHash": hashlib.sha256(payload or b"").hexdigest(),
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
    with urllib.request.urlopen(
        urllib.request.Request(
            f"{BASE_URL}/system/auth/login",
            data=payload,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "migration-guard-quality-readonly/1",
                "X-Device-Id": "migration-guard-readonly",
            },
        ),
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
        raise RuntimeError("login succeeded without access token")
    return f"Bearer {access_token}"


def is_null_semantic(value):
    if value in {13, 14}:
        return True
    normalized = str(value or "").strip().lower().replace("_", " ")
    return normalized in {
        "is null",
        "is not null",
        "isnull",
        "isnotnull",
    }


def collect_conditions(value, path="$"):
    conditions = []
    if isinstance(value, dict):
        where_value = (
            value.get("whereExp")
            if "whereExp" in value
            else value.get("whereExpValue")
        )
        if is_null_semantic(where_value):
            conditions.append(
                {
                    "path": path,
                    **{
                        key: value.get(key)
                        for key in sorted(SAFE_CONDITION_KEYS)
                        if key in value
                    },
                }
            )
        for key, item in value.items():
            conditions.extend(
                collect_conditions(item, f"{path}.{key}")
            )
    elif isinstance(value, list):
        for index, item in enumerate(value):
            conditions.extend(
                collect_conditions(item, f"{path}[{index}]")
            )
    elif isinstance(value, str):
        stripped = value.strip()
        if (
            len(stripped) <= 1_000_000
            and stripped[:1] in {"{", "["}
        ):
            try:
                embedded = json.loads(stripped)
            except json.JSONDecodeError:
                embedded = None
            if embedded is not None:
                conditions.extend(
                    collect_conditions(embedded, f"{path}#json")
                )
    return conditions


def where_exp_distribution(value):
    distribution = {}

    def walk(item):
        if isinstance(item, dict):
            for key, child in item.items():
                if key in {"whereExp", "whereExpValue", "whereExpCode"}:
                    normalized = str(child)
                    distribution[normalized] = (
                        distribution.get(normalized, 0) + 1
                    )
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)
        elif isinstance(item, str):
            stripped = item.strip()
            if (
                len(stripped) <= 1_000_000
                and stripped[:1] in {"{", "["}
            ):
                try:
                    embedded = json.loads(stripped)
                except json.JSONDecodeError:
                    embedded = None
                if embedded is not None:
                    walk(embedded)

    walk(value)
    return distribution


def structural_arrays(value, path="$", depth=0):
    if depth > 5:
        return []
    result = []
    if isinstance(value, list):
        result.append({"path": path, "length": len(value)})
        for index, item in enumerate(value[:2]):
            result.extend(
                structural_arrays(item, f"{path}[{index}]", depth + 1)
            )
    elif isinstance(value, dict):
        for key, item in value.items():
            result.extend(
                structural_arrays(item, f"{path}.{key}", depth + 1)
            )
    return result


def count_scalars(value, wanted_keys):
    counters = {
        key: {"present": 0, "null": 0, "empty": 0, "nonEmpty": 0}
        for key in sorted(wanted_keys)
    }

    def walk(item):
        if isinstance(item, dict):
            for key, child in item.items():
                if key in counters:
                    counters[key]["present"] += 1
                    if child is None:
                        counters[key]["null"] += 1
                    elif child == "":
                        counters[key]["empty"] += 1
                    else:
                        counters[key]["nonEmpty"] += 1
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    return counters


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


def stable_hash(value):
    encoded = json.dumps(
        canonicalize(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


token = login()
query = request_json(
    token,
    "POST",
    "/zboss/data/view/dynamic/engine/use/engine-use-page/query",
    {"usePageId": USE_PAGE_ID},
)
query_data = query["json"].get("data")
conditions = collect_conditions(query_data)
condition_field_names = {
    str(condition.get(key))
    for condition in conditions
    for key in ("fieldName", "field", "tableField")
    if condition.get(key)
}

page_path = (
    "/zboss/data/view/dynamic/engine/use/engine-use-page/"
    f"page?panelId={PANEL_ID}"
)
page_runs = [
    request_json(token, "POST", page_path, PAGE_BODY)
    for _ in range(2)
]

report = {
    "schemaVersion": 1,
    "stage": "zboss-real-quality-page-readonly",
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "baseUrl": BASE_URL,
    "tenantHash": hashlib.sha256(TENANT_ID.encode()).hexdigest(),
    "request": {
        "path": page_path,
        "requestHash": page_runs[0]["requestHash"],
        "pageNo": PAGE_BODY["pageNo"],
        "pageSize": PAGE_BODY["pageSize"],
        "selectFieldCount": len(PAGE_BODY["selectValues"]),
        "skipSavePageSize": True,
    },
    "metadata": {
        "httpStatus": query["status"],
        "businessCode": query["json"].get("code"),
        "responseBytes": len(query["raw"]),
        "responseHash": hashlib.sha256(query["raw"]).hexdigest(),
        "nullSemanticConditionCount": len(conditions),
        "nullSemanticConditions": conditions,
        "whereExpDistribution": where_exp_distribution(query_data),
        "rawNullSemanticPatternCount": len(
            re.findall(
                rb"(?:whereExp|where_exp).{0,24}?(?:13|14|is null|is not null)",
                query["raw"],
                flags=re.IGNORECASE,
            )
        ),
    },
    "pageRuns": [
        {
            "httpStatus": run["status"],
            "businessCode": run["json"].get("code"),
            "elapsedMs": run["elapsedMs"],
            "responseBytes": len(run["raw"]),
            "responseHash": hashlib.sha256(run["raw"]).hexdigest(),
            "semanticHash": stable_hash(run["json"]),
            "topLevelDataKeys": sorted(
                (run["json"].get("data") or {}).keys()
            )
            if isinstance(run["json"].get("data"), dict)
            else [],
            "arrayStructure": structural_arrays(
                run["json"].get("data")
            ),
            "conditionFieldProfile": count_scalars(
                run["json"].get("data"),
                condition_field_names,
            ),
        }
        for run in page_runs
    ],
    "repeat": {
        "requestHashesMatch": (
            page_runs[0]["requestHash"] == page_runs[1]["requestHash"]
        ),
        "rawResponseHashesMatch": (
            hashlib.sha256(page_runs[0]["raw"]).hexdigest()
            == hashlib.sha256(page_runs[1]["raw"]).hexdigest()
        ),
        "semanticHashesMatch": (
            stable_hash(page_runs[0]["json"])
            == stable_hash(page_runs[1]["json"])
        ),
    },
    "safety": {
        "credentialsPersisted": False,
        "rawResponsesPersisted": False,
        "businessFieldValuesPersisted": False,
        "mutatingEndpointsInvoked": False,
        "pagePreferenceWriteSuppressed": True,
    },
}
encoded = json.dumps(
    report,
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
report["reportHash"] = hashlib.sha256(encoded).hexdigest()
print(json.dumps(report, ensure_ascii=False, indent=2))
