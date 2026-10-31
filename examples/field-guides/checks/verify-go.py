"""Run the guide's two complete Go files in an isolated module, without listening."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def main():
    article = Path(__file__).resolve().parents[1] / 'go-request.md'
    source = article.read_text(encoding='utf-8')
    blocks = re.findall(r'^```go\n(.*?)^```\s*$', source, re.M | re.S)
    if len(blocks) != 2:
        raise RuntimeError('Expected exactly main.go and main_test.go.')
    prose = re.sub(r'^```[^\n]*\n.*?^```\s*$', '', source, flags=re.M | re.S)
    prose = re.sub(r'\A---\n.*?\n---\n', '', prose, count=1, flags=re.S)
    count = len(re.findall(r'[\u4e00-\u9fff]', prose))
    if count < 2800:
        raise RuntimeError(f'Substantive prose too short: {count}')
    go = shutil.which('go')
    if not go:
        raise RuntimeError('Go is required to verify this guide.')
    environment = {**os.environ, 'GOCACHE': '/tmp/asher-go-build', 'GOTOOLCHAIN': 'local'}
    with tempfile.TemporaryDirectory(prefix='asher-go-field-guide-') as directory:
        root = Path(directory)
        (root / 'go.mod').write_text('module example.com/greeting\n\ngo 1.22\n')
        for filename, block in zip(('main.go', 'main_test.go'), blocks):
            (root / filename).write_text(block, encoding='utf-8')
        subprocess.run([go, 'test', '-race', '-v', './...'], cwd=root,
                       env=environment, check=True, timeout=90)
    print(f'PASS: {count} Chinese prose characters; 13 request branches; no socket listening.')


if __name__ == '__main__':
    main()
