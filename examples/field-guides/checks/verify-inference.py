"""Run the guide's complete standard-library example and mathematical cases."""
from pathlib import Path
import re
import subprocess
import sys
import tempfile

article = Path(__file__).resolve().parents[1] / "inference.md"
source = article.read_text(encoding="utf-8")
blocks = re.findall(r"```python\n(.*?)\n```", source, flags=re.S)
assert len(blocks) == 1
with tempfile.TemporaryDirectory(prefix="asher-inference-guide-") as directory:
    script = Path(directory) / "request_journey.py"
    script.write_text(blocks[0], encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(script)], capture_output=True, text=True, check=True
    )
    assert result.stdout == "A 0 50 70\nB 65 235 245\n"

namespace = {"__name__": "guide_check"}
exec(compile(blocks[0], str(article), "exec"), namespace)
simulate = namespace["simulate"]
assert simulate([("A", 0, 20, 3), ("B", 5, 20, 2)])[1]["ttft"] == 115
assert simulate([("A", 0, 20, 5), ("B", 5, 80, 2)])[1]["ttft"] == 255
assert simulate([("A", 0, 20, 3), ("B", 5, 80, 2)], prefill_ms=1)[1]["wait"] == 45
assert simulate([("A", 0, 20, 1)])[0]["latency"] == 50
invalid = [
    [("A", -1, 20, 3)],
    [("A", 0, 20, 0)],
    [("A", 0, True, 3)],
    [("A", 0, 20, 3), ("A", 5, 80, 2)],
    [("A", 5, 20, 3), ("B", 0, 80, 2)],
]
for requests in invalid:
    try:
        simulate(requests)
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid request accepted")
body = re.sub(r"\A---\n.*?\n---\n", "", source, flags=re.S)
prose = re.sub(r"```.*?```", "", body, flags=re.S)
count = len(re.findall(r"[\u4e00-\u9fff]", prose))
assert count >= 2800, count
assert len(re.findall(r"```mermaid\n", source)) == 2
assert len(re.findall(r"```chart\n", source)) == 1
assert len(re.findall(r"```explore\n", source)) == 1
print(f"PASS inference guide: {count} Chinese prose characters; model and failure assertions")
