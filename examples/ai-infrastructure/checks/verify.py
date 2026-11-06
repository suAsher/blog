#!/usr/bin/env python3
"""Verify only this authored curriculum, without reading personal documents."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "01-contract.md", "02-load-model.md", "03-memory-budget.md",
    "04-admission-batching.md", "05-reliability.md", "06-capstone.md",
)


def main():
    manifest = json.loads((ROOT / "index.json").read_text())
    assert len(manifest["chapters"]) == 7
    assert manifest["chapters"][0]["existingGuide"] == "inference"
    assert tuple(chapter["file"] for chapter in manifest["chapters"][1:]) == FILES
    results = []
    for name in FILES:
        source = (ROOT / name).read_text()
        assert "生成演示" in source
        body = re.sub(r"\A---\n.*?\n---\n", "", source, count=1, flags=re.S)
        prose = re.sub(r"(?ms)^```[^\n]*\n.*?^```[^\n]*$", "", body)
        count = len(re.findall(r"[\u4e00-\u9fff]", prose))
        assert count >= 2000, (name, count)
        blocks = re.findall(r"(?ms)^```python\n(.*?)^```$", source)
        assert len(blocks) == 1, name
        assert "```mermaid" in source and "## 实践" in source
        with tempfile.TemporaryDirectory(prefix="asher-curriculum-") as directory:
            script = Path(directory) / "example.py"
            script.write_text(blocks[0])
            completed = subprocess.run(
                [sys.executable, "-I", str(script)], cwd=directory,
                capture_output=True, text=True, timeout=10, check=True,
            )
            assert len(completed.stdout) < 4096 and not completed.stderr
        expected = re.findall(r"(?ms)^```text\n(.*?)^```$", source)
        assert len(expected) == 1, name
        assert completed.stdout.strip() == expected[0].strip(), name
        results.append({"file": name, "proseCharacters": count,
                        "sha256": hashlib.sha256(source.encode()).hexdigest(),
                        "output": completed.stdout.strip()})
    print(json.dumps({"verified": len(results), "chapters": 7,
                      "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
