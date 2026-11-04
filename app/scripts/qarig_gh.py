#!/usr/bin/python3 -I
"""qarig's fake gh, copied into an env as bin/gh (the env is the folder above this file's).

Never reaches GitHub. `gh auth token` / `auth status` / `auth git-credential` fail like a logged-out
gh. `gh repo view` names the cwd's origin when it is GitHub-shaped (the demo repo's is
qa-rig/demo-shop). GitHub Actions answers from <env>/gh/runs.json once `qarig scenario <env>
pipelines` wrote it: the runs (every workflow's, or one workflow's under `actions/workflows/<file or
id>/runs`, paged with `per_page` and `page`), a run, its jobs with steps, a job's log, the
workflows, the workflow file at a revision or on a branch (a Deploy workflow runs by hand with an
environment, a dry run and a version), no artifacts and no pending deployments; cancel, rerun and
`gh workflow run <file> --ref <ref> -f k=v` change the file (the latter adds a queued run of the
workflow, by hand, on the ref). With runs.json, `gh api user` is its `me`, else qa-rig. The rest
says there is nothing (`--json`: `[]`).
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl

ENV = Path(__file__).resolve().parent.parent
RUNS = ENV / "gh/runs.json"
ME = "qa-rig"  # `gh api user`'s login without runs.json's `me`
GITHUB = re.compile(r"^(?:https://(?:[^@/]+@)?|ssh://git@|git@)github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", re.I)


def log(argv):
    try:
        with open(ENV / "logs/gh.log", "a") as f:
            f.write("qarig fake gh: " + " ".join(argv) + "\n")
    except OSError:
        pass


def fail(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def out(v):
    print(json.dumps(v) if not isinstance(v, str) else v)
    sys.exit(0)


def origin_repo():
    """The cwd's origin as GitHub's owner/name (its configured URL, not insteadOf's rewrite)."""
    p = subprocess.run(["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True)
    m = GITHUB.match(p.stdout.strip()) if p.returncode == 0 else None
    return m.group(1) if m else None


def flag(argv, name):
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def load():
    try:
        return json.loads(RUNS.read_text())
    except (OSError, ValueError):
        return None


def save(data):
    tmp = RUNS.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=1) + "\n")
    os.replace(tmp, RUNS)


def iso(ms):
    return None if ms is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))


def rest_run(repo, r):
    return {
        "id": r["id"],
        "name": r["workflow"],
        "workflow_id": r["workflow_id"],
        "path": f".github/workflows/{r['file']}",
        "display_title": r["title"],
        "run_number": r["number"],
        "run_attempt": r["attempt"],
        "event": r["event"],
        "status": r["status"],
        "conclusion": r["conclusion"],
        "head_branch": r["branch"],
        "head_sha": r["sha"],
        "created_at": iso(r["created"]),
        "run_started_at": iso(r["started"]),
        "updated_at": iso(r["updated"]),
        "html_url": f"https://github.com/{repo}/actions/runs/{r['id']}",
        "actor": {"login": r["actor"]},
        "triggering_actor": {"login": r["actor"]},
        "pull_requests": [{"number": r["pr"]}] if r.get("pr") else [],
    }


def rest_job(repo, r, j):
    return {
        "id": j["id"],
        "run_id": r["id"],
        "run_attempt": r["attempt"],
        "name": j["name"],
        "status": j["status"],
        "conclusion": j["conclusion"],
        "started_at": iso(j["started"]),
        "completed_at": iso(j["completed"]),
        "html_url": f"https://github.com/{repo}/actions/runs/{r['id']}/job/{j['id']}",
        "labels": ["ubuntu-latest"],
        "steps": [
            {"name": s["name"], "number": n + 1, "status": s["status"], "conclusion": s["conclusion"], "started_at": iso(s["started"]), "completed_at": iso(s["completed"])}
            for n, s in enumerate(j["steps"])
        ],
    }


def cli_run(repo, r, fields):
    """`gh run view --json <fields>`: gh's own camelCase shape."""
    full = {
        "databaseId": r["id"],
        "number": r["number"],
        "workflowName": r["workflow"],
        "displayTitle": r["title"],
        "headBranch": r["branch"],
        "headSha": r["sha"],
        "event": r["event"],
        "status": r["status"],
        "conclusion": r["conclusion"] or "",
        "createdAt": iso(r["created"]),
        "startedAt": iso(r["started"]),
        "updatedAt": iso(r["updated"]),
        "url": f"https://github.com/{repo}/actions/runs/{r['id']}",
        "attempt": r["attempt"],
        "jobs": [
            {
                "databaseId": j["id"],
                "name": j["name"],
                "status": j["status"],
                "conclusion": j["conclusion"] or "",
                "startedAt": iso(j["started"]) or "0001-01-01T00:00:00Z",
                "completedAt": iso(j["completed"]) or "0001-01-01T00:00:00Z",
                "url": f"https://github.com/{repo}/actions/runs/{r['id']}/job/{j['id']}",
                "steps": [{"name": s["name"], "number": n + 1, "status": s["status"], "conclusion": s["conclusion"] or ""} for n, s in enumerate(j["steps"])],
            }
            for j in r["jobs"]
        ],
    }
    keys = [k for k in (fields or "").split(",") if k] or list(full)
    return {k: full[k] for k in keys if k in full}


def find(data, rid):
    return next((r for r in data["runs"] if str(r["id"]) == str(rid)), None)


def not_found(path):
    fail(f"gh: Not Found (HTTP 404)\n{{\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest\",\"status\":\"404\"}}")


def workflow_yaml(r):
    """The run's workflow file: CI on push; a Deploy one on push and by hand, with its inputs."""
    lines = [f"name: {r['workflow']}"]
    if r["workflow"] == "CI":
        lines.append("on: [push, pull_request]")
    else:
        env = r["workflow"].split()[-1].lower()
        lines += [
            "on:",
            "  push:",
            "  workflow_dispatch:",
            "    inputs:",
            "      environment:",
            "        description: Where it deploys",
            "        type: choice",
            "        options: [dev, test]",
            f"        default: {env}",
            "        required: true",
            "      dry-run:",
            "        description: Plan only, deploy nothing",
            "        type: boolean",
            "        default: false",
            "      version:",
            "        description: The build to deploy (default the newest)",
            "        type: string",
        ]
    lines.append("jobs:")
    for j in r["jobs"]:
        lines += [f"  {j['key']}:", f"    name: {j['name']}", "    runs-on: ubuntu-latest"]
        if j.get("needs"):
            lines.append(f"    needs: [{', '.join(j['needs'])}]")
        lines += ["    steps:", "      - run: echo qarig"]
    return "\n".join(lines) + "\n"


def job_log(j):
    t = iso(j["started"]) or iso(int(time.time() * 1000))
    rows = []
    for s in j["steps"]:
        rows.append(f"{t} ##[group]{s['name']}")
        rows.append(f"{t} qarig: {s['name'].lower()}")
        if s["conclusion"] == "failure":
            rows += [f"{t} FAIL src/cart.test.ts > total > adds the prices", f"{t}   expected 30, received 25", f"{t} ##[error]Process completed with exit code 1."]
        rows.append(f"{t} ##[endgroup]")
    return "\n".join(rows) + "\n"


def api(argv):
    method = (flag(argv, "-X") or flag(argv, "--method") or "GET").upper()
    # the path is the first word that is not a flag's value
    skip = set()
    for i, a in enumerate(argv):
        if a in ("-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "--jq", "-q", "--input", "--template", "-t"):
            skip.add(i + 1)
    path = next((a for i, a in enumerate(argv) if i > 0 and i not in skip and not a.startswith("-")), "")
    path, _, query = path.partition("?")
    q = dict(parse_qsl(query))
    for i, a in enumerate(argv):
        if a in ("-f", "-F", "--field", "--raw-field") and i + 1 < len(argv) and "=" in argv[i + 1]:
            k, v = argv[i + 1].split("=", 1)
            q[k] = v
    data = load()
    if path == "user":
        # as a signed-in gh answers it (an empty answer read as "gh answered no JSON")
        me = (data or {}).get("me") or ME
        jq = flag(argv, "--jq") or flag(argv, "-q")
        out(me if jq == ".login" else {"login": me, "id": 1, "type": "User", "name": "QA Rig"})
    m = re.match(r"^/?repos/([^/]+/[^/]+)/(.*)$", path)
    if not m or data is None:
        if "--json" in argv:
            out("[]")
        sys.exit(0)
    repo, rest = m.group(1), m.group(2)
    if rest == "actions/workflows":
        seen = {}
        for r in data["runs"]:
            seen.setdefault(r["workflow_id"], r)
        wf = [{"id": i, "name": r["workflow"], "path": f".github/workflows/{r['file']}", "state": "active"} for i, r in seen.items()]
        out({"total_count": len(wf), "workflows": wf})
    wm = re.match(r"^actions/workflows/([^/]+)/runs$", rest)
    if rest == "actions/runs" or wm:
        runs = data["runs"]
        if wm:  # one workflow's: by its file's name or its id
            runs = [r for r in runs if wm.group(1) in (r["file"], str(r["workflow_id"]))]
        if q.get("branch"):
            runs = [r for r in runs if r["branch"] == q["branch"]]
        if q.get("head_sha"):
            runs = [r for r in runs if r["sha"] == q["head_sha"]]
        if q.get("event"):
            runs = [r for r in runs if r["event"] == q["event"]]
        if q.get("status"):
            runs = [r for r in runs if q["status"] in (r["status"], r["conclusion"])]
        per = int(q.get("per_page", 30))
        page = int(q.get("page", 1))
        out({"total_count": len(runs), "workflow_runs": [rest_run(repo, r) for r in runs[(page - 1) * per : page * per]]})
    jm = re.match(r"^actions/jobs/(\d+)/logs$", rest)
    if jm:
        for r in data["runs"]:
            for j in r["jobs"]:
                if str(j["id"]) == jm.group(1):
                    print(job_log(j), end="")
                    sys.exit(0)
        not_found(path)
    rm = re.match(r"^actions/runs/(\d+)(?:/attempts/(\d+))?(?:/(.*))?$", rest)
    if rm:
        r = find(data, rm.group(1))
        if r is None:
            not_found(path)
        tail = rm.group(3) or ""
        if tail == "":
            out(rest_run(repo, r))
        if tail == "jobs":
            page = int(q.get("page", 1))
            jobs = [rest_job(repo, r, j) for j in r["jobs"]] if page == 1 else []
            out({"total_count": len(r["jobs"]), "jobs": jobs})
        if tail == "artifacts":
            out({"total_count": 0, "artifacts": []})
        if tail == "pending_deployments":
            out([])
        if method == "POST" and tail in ("cancel", "rerun", "rerun-failed-jobs"):
            now = int(time.time() * 1000)
            if tail == "cancel":
                r.update(status="completed", conclusion="cancelled", updated=now)
                for j in r["jobs"]:
                    if j["status"] != "completed":
                        j.update(status="completed", conclusion="cancelled", completed=now)
            else:
                r.update(status="queued", conclusion=None, attempt=r["attempt"] + 1, started=now, updated=now)
                for j in r["jobs"]:
                    if tail == "rerun" or j["conclusion"] != "success":
                        j.update(status="queued", conclusion=None, started=None, completed=None)
                        for s in j["steps"]:
                            s.update(status="queued", conclusion=None, started=None, completed=None)
            save(data)
            sys.exit(0)
        not_found(path)
    cm = re.match(r"^contents/(.+)$", rest)
    if cm and cm.group(1).startswith(".github/workflows/"):
        file = cm.group(1).rsplit("/", 1)[-1]
        ref = q.get("ref")
        # at a revision: that run's file; on a branch (or none): the workflow's newest
        r = next((r for r in data["runs"] if r["file"] == file and r["sha"] == ref), None) if ref else None
        if r is None and not any(r["sha"] == ref for r in data["runs"]):
            r = next((r for r in data["runs"] if r["file"] == file), None)
        if r is None:
            not_found(path)
        print(workflow_yaml(r), end="")
        sys.exit(0)
    if "--json" in argv:
        out("[]")
    sys.exit(0)


def run_cmd(argv):
    data = load()
    repo = flag(argv, "--repo") or flag(argv, "-R") or origin_repo() or ""
    sub = argv[1] if len(argv) > 1 else ""
    if data is None:
        if sub == "view":
            fail("no runs (qarig: qarig scenario <env> pipelines)")
        out("[]")
    if sub == "view":
        rid = next((a for a in argv[2:] if a.isdigit()), None)
        r = find(data, rid) if rid else None
        if r is None:
            fail(f"could not find any workflow run with ID {rid}")
        out(cli_run(repo, r, flag(argv, "--json")))
    if sub == "list":
        runs = data["runs"]
        if flag(argv, "--branch") or flag(argv, "-b"):
            runs = [r for r in runs if r["branch"] == (flag(argv, "--branch") or flag(argv, "-b"))]
        if flag(argv, "--workflow") or flag(argv, "-w"):
            w = flag(argv, "--workflow") or flag(argv, "-w")
            runs = [r for r in runs if w in (r["workflow"], r["file"])]
        limit = int(flag(argv, "--limit") or flag(argv, "-L") or 20)
        out([cli_run(repo, r, flag(argv, "--json")) for r in runs[:limit]])
    sys.exit(0)


def workflow_cmd(argv):
    """`gh workflow run <file> --ref <ref> -f k=v…`: a queued run of the workflow, by hand, newest."""
    data = load()
    sub = argv[1] if len(argv) > 1 else ""
    if sub != "run":
        out("[]" if "--json" in argv else "")
    if data is None:
        fail("no workflows (qarig: qarig scenario <env> pipelines)")
    # the file is the first word after `run` that is not a flag's value
    skip = set()
    for i, a in enumerate(argv):
        if a in ("--ref", "-r", "--repo", "-R", "-f", "-F", "--field", "--raw-field", "--json"):
            skip.add(i + 1)
    file = next((a for i, a in enumerate(argv) if i > 1 and i not in skip and not a.startswith("-")), None)
    like = next((r for r in data["runs"] if r["file"] == file or r["workflow"] == file), None)
    if like is None:
        fail(f"could not find any workflows named {file}")
    if like["workflow"] == "CI":
        fail(f"HTTP 422: Workflow does not have 'workflow_dispatch' trigger (https://docs.github.com/rest)")
    inputs = {}
    for i, a in enumerate(argv):
        if a in ("-f", "-F", "--field", "--raw-field") and i + 1 < len(argv) and "=" in argv[i + 1]:
            k, v = argv[i + 1].split("=", 1)
            inputs[k] = v
    now = int(time.time() * 1000)
    rid = max(r["id"] for r in data["runs"]) + 7_919
    number = max(r["number"] for r in data["runs"] if r["workflow"] == like["workflow"]) + 1
    jobs = []
    for k, j in enumerate(like["jobs"]):
        steps = [{"name": s["name"], "status": "queued", "conclusion": None, "started": None, "completed": None} for s in j["steps"]]
        jobs.append({"id": 51_000_000_000 + rid % 1_000_000 * 10 + k, "key": j["key"], "name": j["name"], "needs": j.get("needs", []), "status": "queued", "conclusion": None, "started": None, "completed": None, "steps": steps})
    env = inputs.get("environment")
    data["runs"].insert(
        0,
        {
            "id": rid,
            "number": number,
            "workflow": like["workflow"],
            "workflow_id": like["workflow_id"],
            "file": like["file"],
            "title": like["workflow"] + (f" · {env}" if env else ""),
            "attempt": 1,
            "event": "workflow_dispatch",
            "status": "queued",
            "conclusion": None,
            "branch": flag(argv, "--ref") or flag(argv, "-r") or "main",
            "sha": like["sha"],
            "created": now,
            "started": now,
            "updated": now,
            "actor": (data.get("me") or ME),
            "pr": None,
            "inputs": inputs,
            "jobs": jobs,
        },
    )
    save(data)
    print(f"✓ Created workflow_dispatch event for {like['file']} at {flag(argv, '--ref') or 'main'}")
    sys.exit(0)


def main(argv):
    log(argv)
    head = " ".join(argv[:2])
    if head in ("auth token", "auth status", "auth git-credential"):
        fail("not logged in (qarig)")
    if head == "repo view":
        repo = (argv[2] if len(argv) > 2 and not argv[2].startswith("-") else None) or origin_repo()
        if repo is None:
            fail("none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`")
        jq = flag(argv, "--jq") or flag(argv, "-q")
        if jq == ".nameWithOwner":
            out(repo)
        owner, name = repo.split("/", 1)
        full = {"nameWithOwner": repo, "name": name, "owner": {"login": owner}, "url": f"https://github.com/{repo}", "defaultBranchRef": {"name": "main"}}
        fields = flag(argv, "--json")
        out({k: full[k] for k in fields.split(",") if k in full} if fields else f"{repo}\n")
    if argv[:1] == ["api"]:
        api(argv)
    if argv[:1] == ["run"]:
        run_cmd(argv)
    if argv[:1] == ["workflow"]:
        workflow_cmd(argv)
    if "--json" in argv:
        out("[]")
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv[1:])
