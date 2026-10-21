"""Operator-host acceptance for mythos-vibe read-only routes (real SSH sandbox).

No credentials are printed or saved. Run from ~/mythos-m1 on the DSH host.
"""
import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ORIGIN = "http://127.0.0.1:3080"
log = (Path.home() / "dsh-run/dsh.log").read_text()
auth_url = re.search(r"http://127.0.0.1:3080/\?token=[A-Za-z0-9_-]+", log).group()


def opener_with_cookie():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(auth_url).close()
    return op


anon = urllib.request.build_opener()
op = opener_with_cookie()
results = {}


def get(opener, path):
    try:
        with opener.open(ORIGIN + path, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


# 1. unauthenticated -> 401
results["unauthenticated_401"] = get(anon, "/mythos/vibe/tasks/work-x/context")[0]

# 2. find a real work item with sandbox bound
works = get(op, "/mythos/api/work-items")[1]["workItems"]
wid, context = None, None
for w in works:
    st, ctx = get(op, "/mythos/vibe/tasks/{}/context".format(w["workItemId"]))
    if st == 200 and ctx.get("sandboxId"):
        wid, context = w["workItemId"], ctx
        break
assert wid, "no work item with bound sandbox"
results["context"] = {"workItemId": wid, "phase": context["phase"], "sandboxId": context["sandboxId"],
                      "deliveryStep": (context.get("delivery") or {}).get("step")}

# 3. diff with ETag + 304 replay
st1, diff = get(op, "/mythos/vibe/tasks/{}/diff".format(wid))
with op.open(urllib.request.Request(ORIGIN + "/mythos/vibe/tasks/{}/diff".format(wid)), timeout=60) as r:
    etag = r.headers.get("ETag")
try:
    op.open(urllib.request.Request(ORIGIN + "/mythos/vibe/tasks/{}/diff".format(wid),
                                    headers={"If-None-Match": etag}), timeout=60)
    replay = "NOT_304"
except urllib.error.HTTPError as e:
    replay = e.code
results["diff"] = {"status": st1, "baseCommit": (diff or {}).get("baseCommit"),
                   "headCommit": (diff or {}).get("headCommit"), "changedFiles": (diff or {}).get("changedFiles"),
                   "testsChanged": (diff or {}).get("testsChanged"), "diffTruncated": (diff or {}).get("diffTruncated"),
                   "etag": etag, "replay": replay}

# 4. real sandbox file read via SSH
src = (context.get("source") or {}).get("sourcePath") or "pom.xml"
q = urllib.parse.quote(src, safe="")
st, body = get(op, "/mythos/vibe/tasks/{}/files?path={}&offset=1&limit=50".format(wid, q))
results["files_read"] = {"path": src, "status": st, "version": (body or {}).get("version"),
                         "lineCount": (body or {}).get("lineCount"), "firstLines": (body or {}).get("lines", [])[:3]}

# 5. guards: escape / not-a-file / missing / method / unknown task
results["escape_400"] = get(op, "/mythos/vibe/tasks/{}/files?path=../etc/passwd".format(wid))[0]
results["dotdot_400"] = get(op, "/mythos/vibe/tasks/{}/files?path=..%2F..%2Fetc%2Fpasswd".format(wid))[0]
results["not_a_file_400"] = get(op, "/mythos/vibe/tasks/{}/files?path=src".format(wid))[0]
results["missing_404"] = get(op, "/mythos/vibe/tasks/{}/files?path=no-such-file-xyz.txt".format(wid))[0]
try:
    op.open(urllib.request.Request(ORIGIN + "/mythos/vibe/tasks/{}/diff".format(wid), data=b"{}", method="POST"),
            timeout=60)
    results["post_405"] = "NOT_405"
except urllib.error.HTTPError as e:
    results["post_405"] = e.code
results["unknown_task_404"] = get(op, "/mythos/vibe/tasks/work-deadbeef/context")[0]

out = Path.home() / "mythos-m1/state/vibe-acceptance.json"
out.write_text(json.dumps(results, ensure_ascii=False, indent=2))
out.chmod(0o600)
print(json.dumps(results, ensure_ascii=False, indent=2))
