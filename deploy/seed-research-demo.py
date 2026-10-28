#!/usr/bin/env python3
"""Seed generated research examples on the server; never export credentials."""
import argparse
import hashlib
import http.cookiejar
import json
import mimetypes
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BUNDLE = [
    "articles/01-latency-budget.md",
    "articles/02-reproducible-notebook.md",
    "articles/03-source-evidence.md",
    "articles/04-review-runbook.md",
    "notes/演示 · 轮值交接便笺.txt",
    "images/latency-budget.png",
    "images/evidence-loop.png",
]
SEED = "research-20261028"


def private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
            raise RuntimeError("Private configuration permissions or size are invalid.")
        return json.load(stream)


def save_marker(path, value):
    directory = path.parent
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
        raise RuntimeError("Unsafe showcase metadata directory.")
    temporary = directory / (".seed-" + uuid.uuid4().hex)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def load_examples(examples):
    payloads = []
    for relative in BUNDLE:
        path = examples / "import-bundle" / relative
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Expected generated fixture is missing or unsafe.")
        data = path.read_bytes()
        if path.suffix != ".png" and "生成" not in data.decode("utf-8"):
            raise RuntimeError("Generated-document notice missing.")
        payloads.append((relative, data))
    return payloads


def multipart(payloads, decisions):
    boundary = "asher-generated-" + uuid.uuid4().hex
    parts = []
    fields = [("paths", [path for path, _ in payloads])]
    if decisions is not None:
        fields.append(("decisions", decisions))
    for name, value in fields:
        parts.append(("--" + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n').encode())
        parts.append(json.dumps(value, ensure_ascii=False).encode() + b"\r\n")
    for index, (path, data) in enumerate(payloads):
        extension = Path(path).suffix
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        header = ('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="fixture-' + str(index) + extension + '"\r\nContent-Type: ' + mime + '\r\n\r\n')
        parts.extend([header.encode(), data, b"\r\n"])
    parts.append(("--" + boundary + "--\r\n").encode())
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


class Client:
    def __init__(self, credentials):
        address = urllib.parse.urlsplit(credentials["url"])
        if address.scheme != "https" or not address.hostname or address.username or address.password or address.path not in ("", "/") or address.query or address.fragment:
            raise RuntimeError("Expected a credential-free HTTPS origin.")
        self.origin = urllib.parse.urlunsplit((address.scheme, address.netloc, "", "", ""))
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.call("POST", "/auth/login", {"username": credentials["username"], "password": credentials["password"]})

    def call(self, method, path, data=None, content_type="application/json"):
        if not path.startswith("/") or path.startswith("//"):
            raise RuntimeError("Only same-origin API paths are allowed.")
        body = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(self.origin + path, data=body, method=method,
            headers={"Origin": self.origin, "Content-Type": content_type})
        try:
            with self.http.open(request, timeout=30) as response:
                result = json.load(response)
                if not result.get("ok"):
                    raise RuntimeError("Server rejected the generated demo request.")
                return result.get("data", result)
        except urllib.error.HTTPError as error:
            raise RuntimeError("Generated demo request failed: " + str(error.code) + " " + path.split("?")[0]) from None


def publish(client, document):
    if document["status"] == "published":
        return document
    return client.call("POST", "/api/documents/" + document["id"] + "/publish", {"version": document["version"]})


def create_written(client, source, title, publish_now):
    document = client.call("POST", "/api/documents", {
        "title": title, "description": "生成演示：展示站内写作与研究流程，不代表真实经历或实测结果。",
        "date": "2026-10-28", "tags": ["生成演示", "站内写作"], "category": "",
        "cover": "", "source": source, "series": "演示 · 推理工程研究路线", "maturity": "growing",
    })
    return publish(client, document) if publish_now else document


def seed(client, examples, payloads, marker, state):
    if "imported" not in state:
        preview_body, preview_mime = multipart(payloads, None)
        preview = client.call("POST", "/api/import/preview", preview_body, preview_mime)
        if len(preview["candidates"]) != 5 or preview["unresolvedImages"] or any(item["status"] == "invalid" for item in preview["candidates"]):
            raise RuntimeError("Generated fixture preview was incomplete; no documents were imported.")
        decisions = {"requestId": state["requestId"], "paths": [
            {"path": path, "action": "create"} for path, _ in payloads if not path.endswith(".png")
        ]}
        body, mime = multipart(payloads, decisions)
        report = client.call("POST", "/api/import", body, mime)
        if len(report["imported"]) != 5 or report["unresolvedImages"]:
            raise RuntimeError("Generated fixture import was incomplete; retained report is available in the editor.")
        state["imported"] = report["imported"]
        state["reportId"] = report["id"]
        save_marker(marker, state)
    documents = []
    for summary in state["imported"]:
        current = client.call("GET", "/api/documents/" + summary["id"])
        if not current["title"].startswith("演示 ·"):
            raise RuntimeError("An owned demo was manually renamed; no automatic changes were made to it.")
        if current["status"] == "draft" and current["version"] != summary["version"]:
            raise RuntimeError("An owned draft was manually edited; publish it explicitly if desired.")
        documents.append(publish(client, current))
    state["imported"] = [{"id": doc["id"], "title": doc["title"], "version": doc["version"], "status": doc["status"]} for doc in documents]
    save_marker(marker, state)
    for key, filename, title, published in [
        ("written", "written-article.md", "演示 · 从一次阅读，到一份自己的结论", True),
        ("draft", "experiment-template.md", "演示 · 待验证实验的记录模板", False),
    ]:
        if key not in state:
            state[key] = create_written(client, (examples / filename).read_text(encoding="utf-8"), title, published)
            state[key] = {field: state[key][field] for field in ("id", "title", "version", "status")}
            save_marker(marker, state)
    ordered = [next(doc for doc in documents if term in doc["title"]) for term in ("推理延迟", "可复现实验", "源码阅读", "复盘结论")]
    if "workspace" not in state:
        ids = [doc["id"] for doc in ordered] + [state["written"]["id"], state["draft"]["id"]]
        workspace = client.call("POST", "/api/workspaces", {
            "title": "演示 · 一次可复查的工程研究", "description": "全部为生成示例：沿着预算、实验与证据，整理自己的阅读路径。",
            "documentIds": ids, "questions": [
                {"id": "demo_question_1", "text": "哪些数字只是构造的预算，不能当作实测结果？", "done": False},
                {"id": "demo_question_2", "text": "下一次实验需要固定哪些输入条件？", "done": False},
            ], "positions": [{"id": value, "x": 40 + (index % 2) * 300, "y": 40 + (index // 2) * 150} for index, value in enumerate(ids)],
        })
        state["workspace"] = workspace["id"]
        save_marker(marker, state)
    if "annotation" not in state:
        annotation = client.call("POST", "/api/annotations", {
            "documentId": ordered[0]["id"], "quote": {"exact": "预算是下一次实验的地图，不是这一次结果的奖状。", "prefix": "", "suffix": ""},
            "body": "生成演示批注：把假设、预算和证据分别保存，下一次阅读时才容易判断结论适用的范围。", "color": "mint",
        })
        state["annotation"] = annotation["id"]
        save_marker(marker, state)
    state["complete"] = True
    save_marker(marker, state)
    return {"published": 6, "drafts": 1, "uploaded": 5, "written": 2,
        "workspaceURL": client.origin + "/workspaces/?id=" + state["workspace"],
        "articleURL": client.origin + "/articles/" + ordered[0]["id"] + "/"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--examples", type=Path, required=True)
    parser.add_argument("--server-root", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    payloads = load_examples(args.examples)
    for filename in ("written-article.md", "experiment-template.md"):
        path = args.examples / filename
        if path.is_symlink() or "生成演示" not in path.read_text(encoding="utf-8"):
            raise RuntimeError("Generated writing fixture notice missing.")
    if args.dry_run:
        print(json.dumps({"generatedOnly": True, "uploadFiles": len(payloads), "writtenDocuments": 2}))
        return
    if not args.server_root:
        parser.error("--server-root is required outside --dry-run")
    marker = args.server_root / "showcases" / (SEED + ".json")
    state = private_json(marker) if marker.exists() else {"requestId": uuid.uuid4().hex}
    if state.get("complete"):
        print(json.dumps({"alreadySeeded": True, "message": "Existing demos were left unchanged."}))
        return
    save_marker(marker, state)
    client = Client(private_json(args.server_root / "secrets" / "access.json"))
    print(json.dumps(seed(client, args.examples, payloads, marker, state), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print("Demo setup stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
