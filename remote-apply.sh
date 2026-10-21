#!/bin/bash
# One-shot apply: sync sandboxctl plugin files to the operator host, reinstall
# presets, restart DSH, and report preset health. Run from the m1 repo root.
# Requires: passwordless ssh to the operator host (key already authorized).
set -euo pipefail
HOST="hx@2408:8240:1210:cce0:34ed:a4ff:fee1:3fd2"
cd "$(dirname "$0")"

echo "== syncing broker + plugin files"
ssh -o BatchMode=yes "$HOST" 'mkdir -p ~/mythos-m1/plugins/mythos-sandbox'
scp -o BatchMode=yes sandbox.py configure_presets.py "hx@[2408:8240:1210:cce0:34ed:a4ff:fee1:3fd2]:~/mythos-m1/"
scp -o BatchMode=yes plugins/mythos-sandbox/index.mjs "hx@[2408:8240:1210:cce0:34ed:a4ff:fee1:3fd2]:~/mythos-m1/plugins/mythos-sandbox/"

echo "== reinstalling presets and restarting DSH"
ssh -o BatchMode=yes "$HOST" 'export PATH="$HOME/tools/node/bin:$PATH"; cd ~/mythos-m1 && python3 configure_presets.py && python3 restart-dsh.py && sleep 4 && python3 -c "
import json
d = json.load(open(\"state/runtime-diagnostic.json\"))
print([(p[\"id\"], p.get(\"broken\", \"ok\")) for p in d[\"presets\"]])"'
echo "== apply done; next: headless probe via state/poc-requests.json, then browser trial"
