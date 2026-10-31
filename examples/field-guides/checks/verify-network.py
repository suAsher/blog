"""Run only the complete, authored loopback experiment from its Markdown source."""
import re
from pathlib import Path
import subprocess
import sys
import tempfile

article = Path(__file__).resolve().parents[1] / "linux-network.md"
source = article.read_text(encoding="utf-8")
blocks = re.findall(r"```python\n(.*?)\n```", source, flags=re.S)
assert len(blocks) == 1
expected = (
    "success: HTTP 200\n"
    "missing: HTTP 404\n"
    "refused: no HTTP status\n"
    "timeout: waiting for response headers\n"
)
with tempfile.TemporaryDirectory(prefix="asher-network-guide-") as directory:
    path = Path(directory) / "network_lab.py"
    path.write_text(blocks[0], encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(path)], cwd=directory,
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert len(lines) == 4, result.stdout
    assert lines[:2] == expected.splitlines()[:2], result.stdout
    assert lines[2] in ("refused: no HTTP status", "connect-timeout: no HTTP status"), result.stdout
    assert lines[3] == expected.splitlines()[3], result.stdout
    assert not result.stderr, result.stderr
prose = re.sub(r"\A---\n.*?\n---\n", "", source, flags=re.S)
prose = re.sub(r"(?ms)^```.*?^```\s*$", "", prose)
count = len(re.findall(r"[\u4e00-\u9fff]", prose))
assert count >= 2800, count
print(result.stdout, end="")
print(f"PASS: loopback success/404/connection failure/header-timeout; {count} Chinese prose characters")
