#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/mythos-security-platform/backend" >&2
  exit 2
fi
backend=$(cd "$1" && pwd)
root=$(cd "$(dirname "$0")" && pwd)

python3 - "$backend" "$root" <<'PY'
from pathlib import Path
import sys
backend, overlay = map(Path, sys.argv[1:])
entity = backend / "src/main/java/com/example/mythosdemo/domain/Finding.java"
controller = backend / "src/main/java/com/example/mythosdemo/api/FindingController.java"
errors = backend / "src/main/java/com/example/mythosdemo/api/ApiErrorHandler.java"

def replace_once(path, old, new):
    text = path.read_text()
    if new and new in text:
        return
    if old not in text:
        if not new:
            return
        raise SystemExit(f"cannot apply overlay: expected anchor missing in {path}")
    path.write_text(text.replace(old, new, 1))

replace_once(entity, "    public long revision=1;", "    @Version\n    public long revision=1;")
replace_once(controller,
    "import org.springframework.web.bind.annotation.*;",
    "import org.springframework.web.bind.annotation.*;\nimport org.springframework.transaction.annotation.Transactional;")
replace_once(controller,
    "    @PatchMapping(\"/findings/{id}\") public Finding update(",
    "    @PatchMapping(\"/findings/{id}\") @Transactional public Finding update(")
replace_once(controller, "        f.revision++;\n", "")
if "f.revision++;" in controller.read_text():
    raise SystemExit(f"cannot apply overlay: legacy manual revision increment remains in {controller}")
if "OptimisticLockingFailureException" not in errors.read_text().split("public class ApiErrorHandler", 1)[-1]:
    replace_once(errors,
        "import org.springframework.http.*;",
        "import org.springframework.http.*;\nimport org.springframework.dao.OptimisticLockingFailureException;")
    text = errors.read_text()
    closing = text.rfind("}")
    if closing < 0:
        raise SystemExit(f"cannot apply overlay: class closing brace missing in {errors}")
    text = text[:closing] + '''    @ExceptionHandler({OptimisticLockingFailureException.class, jakarta.persistence.OptimisticLockException.class})
    public ResponseEntity<Map<String,String>> conflict(Exception e){
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message","Finding changed concurrently; reload and retry"));
    }
''' + text[closing:]
    errors.write_text(text)

for name in ['AiCompletionController.java', 'OwnerNotificationController.java', 'PushTaskController.java',
             'ResetFindingController.java']:
    target = backend / 'src/main/java/com/example/mythosdemo/api' / name
    source = (overlay / name).read_text()
    if target.exists() and target.read_text() != source:
        raise SystemExit(f'refusing to overwrite different file: {target}')
    target.write_text(source)
for name in ['AiCompletionIntegrationTests.java', 'OwnerNotificationIntegrationTests.java']:
    target = backend / 'src/test/java/com/example/mythosdemo' / name
    source = (overlay / 'tests' / name).read_text()
    if target.exists() and target.read_text() != source:
        raise SystemExit(f'refusing to overwrite different file: {target}')
    target.write_text(source)
PY
