#!/usr/bin/env python3
"""Seed generated Go learning articles through authenticated same-origin APIs.

Production credentials and cookies stay inside the server process. Completed
runs never update existing documents or paths. Import receipts protect retries.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid


def helpers():
    path = Path(__file__).with_name('seed-research-demo.py')
    spec = importlib.util.spec_from_file_location('research_seed_helpers', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_examples(directory):
    index_path = directory / 'index.json'
    if index_path.is_symlink() or index_path.stat().st_size > 65536:
        raise RuntimeError('Unsafe generated learning manifest.')
    manifest = json.loads(index_path.read_text(encoding='utf-8'))
    if len(manifest['chapters']) != 6 or manifest['accent'] != 'blue':
        raise RuntimeError('Expected the six-chapter generated Go fixture.')
    payloads = []
    names = set()
    for chapter in manifest['chapters']:
        if len(chapter['lessons']) != 2:
            raise RuntimeError('Expected two lessons per demo chapter.')
        for lesson in chapter['lessons']:
            filename = lesson['file']
            if not re.fullmatch(r'[0-9]{2}-[a-z-]+\.md', filename) or filename in names:
                raise RuntimeError('Unsafe or duplicate lesson filename.')
            names.add(filename)
            path = directory / filename
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
                raise RuntimeError('Unsafe generated lesson file.')
            raw = path.read_bytes()
            source = raw.decode('utf-8')
            if '生成演示内容' not in source or len(re.findall(r'[\u4e00-\u9fff]', source)) < 350:
                raise RuntimeError('Generated lesson notice or substantive prose is missing.')
            if f'title: "{lesson["title"]}"' not in source or '```go\n' not in source:
                raise RuntimeError('Generated lesson metadata or runnable example is missing.')
            payloads.append(('learning-go/' + filename, raw))
    return manifest, payloads


def path_input(manifest, documents):
    chapters = []
    for chapter in manifest['chapters']:
        chapters.append({
            'id': chapter['id'], 'title': chapter['title'],
            'description': chapter['description'],
            'documentIds': [documents['learning-go/' + lesson['file']]['id'] for lesson in chapter['lessons']],
        })
    return {**{key: manifest[key] for key in ('title', 'description', 'accent')}, 'chapters': chapters}


def seed(client, directory, manifest, payloads, marker, state, helper):
    if 'documents' not in state:
        body, mime = helper.multipart(payloads, {
            'requestId': state['requestId'],
            'paths': [{'path': path, 'action': 'create'} for path, _ in payloads],
        })
        report = client.call('POST', '/api/import', body, mime)
        if len(report['imported']) != 12 or report['unresolvedImages']:
            raise RuntimeError('Incomplete generated import; inspect its saved import report.')
        summaries = {value['id']: value for value in report['imported']}
        documents = {}
        for outcome in report['outcomes']:
            if outcome.get('id') in summaries:
                value = summaries[outcome['id']]
                documents[outcome['path']] = {key: value[key] for key in ('id', 'title', 'status', 'version')}
        if set(documents) != {path for path, _ in payloads}:
            raise RuntimeError('Generated import receipt paths are incomplete.')
        state['documents'] = documents
        state['reportId'] = report['id']
        helper.save_marker(marker, state)
    expected = {'learning-go/' + lesson['file']: lesson['title']
                for chapter in manifest['chapters'] for lesson in chapter['lessons']}
    for filename, document in list(state['documents'].items()):
        current = client.call('GET', '/api/documents/' + document['id'])
        if current['title'] != expected.get(filename) or '生成演示内容' not in current['source']:
            raise RuntimeError('An owned demo was edited; automatic publishing was stopped.')
        if current['status'] == 'draft' and current['version'] != document['version']:
            raise RuntimeError('An owned draft changed; publish it explicitly if desired.')
        if current['status'] not in ('draft', 'published'):
            raise RuntimeError('An owned demo is unavailable; no restoration was attempted.')
        current = helper.publish(client, current)
        state['documents'][filename] = {key: current[key] for key in ('id', 'title', 'status', 'version')}
        helper.save_marker(marker, state)
    value = path_input(manifest, state['documents'])
    if 'pathId' not in state:
        # Recover a response lost after path creation without changing any path.
        paths = client.call('GET', '/api/learning-paths')['paths']
        matching = [path for path in paths if all(path.get(key) == data for key, data in value.items())]
        if len(matching) > 1:
            raise RuntimeError('Multiple matching generated routes need manual review.')
        path = matching[0] if matching else client.call('POST', '/api/learning-paths', value)
        state['pathId'] = path['id']
        helper.save_marker(marker, state)
    state['complete'] = True
    helper.save_marker(marker, state)
    return {'generatedOnly': True, 'published': 12, 'chapters': 6,
            'learningURL': client.origin + '/learn/?id=' + state['pathId']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--examples', type=Path, required=True)
    parser.add_argument('--server-root', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    manifest, payloads = load_examples(args.examples)
    if args.dry_run:
        print(json.dumps({'generatedOnly': True, 'chapters': 6, 'articles': len(payloads),
                          'sourceBytes': sum(len(data) for _, data in payloads)}))
        return
    if not args.server_root:
        parser.error('--server-root is required outside --dry-run')
    helper = helpers()
    marker = args.server_root / 'showcases/learning-go-v1.json'
    state = helper.private_json(marker) if marker.exists() else {'requestId': uuid.uuid4().hex}
    if state.get('complete'):
        print(json.dumps({'alreadySeeded': True, 'message': 'Existing learning demos were left unchanged.'}))
        return
    helper.save_marker(marker, state)
    client = helper.Client(helper.private_json(args.server_root / 'secrets/access.json'))
    print(json.dumps(seed(client, args.examples, manifest, payloads, marker, state, helper)))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        print('Learning demo setup stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
