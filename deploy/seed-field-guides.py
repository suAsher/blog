#!/usr/bin/env python3
"""Publish original generated long guides without replacing existing sources."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

GUIDES = {
    'inference': ('ai-inference', 'inference'),
    'go-request': ('go', 'go-request'),
    'linux-network': ('linux-network', 'network'),
}


def helpers():
    spec = importlib.util.spec_from_file_location(
        'catalog_helpers', Path(__file__).with_name('seed-learning-catalog.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, module.helpers()


def prose_count(source):
    body = re.sub(r'\A---\r?\n.*?\r?\n---\r?\n', '', source, count=1, flags=re.S)
    body = re.sub(r'(?ms)^```[^\n]*\n.*?^```[^\n]*$', '', body)
    return len(re.findall(r'[\u4e00-\u9fff]', body))


def load_examples(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError('Unsafe field guide directory.')
    payloads = []
    for slug, (_, kind) in GUIDES.items():
        path = directory / (slug + '.md')
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 131072:
            raise RuntimeError('Missing, unsafe or oversized guide: ' + slug)
        raw = path.read_bytes()
        source = raw.decode('utf-8')
        title = re.search(r'^title: "([^"\r\n]{1,160})"$', source, re.M)
        blocks = re.findall(r'(?ms)^```explore\s*\n(.*?)^```\s*$', source)
        if not title or not title[1].startswith('演示 ·'):
            raise RuntimeError('Explicit generated guide title required: ' + slug)
        if prose_count(source) < 2800 or '生成演示' not in source:
            raise RuntimeError('Substantive generated prose required: ' + slug)
        if len(blocks) != 1 or json.loads(blocks[0]).get('kind') != kind:
            raise RuntimeError('Expected one matching teaching component: ' + slug)
        payloads.append(('field-guides/' + slug + '.md', raw))
        image = directory / 'images' / (slug + '.png')
        if image.is_symlink() or not image.is_file() or image.stat().st_size > 153600:
            raise RuntimeError('Expected bounded original cover: ' + slug)
        image_data = image.read_bytes()
        if not image_data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise RuntimeError('Cover is not a PNG: ' + slug)
        payloads.append(('field-guides/images/' + slug + '.png', image_data))
    return payloads


def attach_input(path, slug, document_id):
    if any(document_id in chapter['documentIds'] for chapter in path['chapters']):
        return None
    chapter_id = 'field-guide-' + slug + '-v1'
    if any(chapter['id'] == chapter_id for chapter in path['chapters']):
        raise RuntimeError('Guide chapter was edited; review the existing route.')
    if len(path['chapters']) >= 30:
        raise RuntimeError('Route chapter budget reached; arrange the guide manually.')
    chapter = {
        'id': chapter_id,
        'title': '深度导读 · 从一个问题看全貌',
        'description': '结合图解、可控实验和完整推演理解这一方向，再按需进入基础章节。',
        'documentIds': [document_id],
    }
    return {
        **{key: path[key] for key in ('title', 'description', 'accent', 'version')},
        'chapters': [chapter, *path['chapters']],
    }


def route_marker(root, slug):
    direction = GUIDES[slug][0]
    name = ('learning-go-v1.json' if direction == 'go' else
            'learning-catalog-' + direction + '-v1.json')
    return root / 'showcases' / name


def publish(client, root, payloads, marker, state, catalog, helper):
    fingerprint = hashlib.sha256(b''.join(raw for _, raw in payloads)).hexdigest()
    if state.get('fingerprint') not in (None, fingerprint):
        raise RuntimeError('Unfinished field guide fixtures changed; review the private receipt.')
    state['fingerprint'] = fingerprint
    routes = {}
    for slug in GUIDES:
        existing = helper.private_json(route_marker(root, slug))
        route_id = existing['pathId']
        if not re.fullmatch(r'[a-f0-9]{32}', route_id):
            raise RuntimeError('Invalid existing route identifier.')
        routes[slug] = client.call('GET', '/api/learning-paths/' + route_id)
    if 'documents' not in state:
        body, mime = helper.multipart(payloads, {
            'requestId': state['requestId'],
            'paths': [{'path': path, 'action': 'create'} for path, _ in payloads
                      if path.endswith('.md')],
        })
        report = client.call('POST', '/api/import', body, mime)
        if len(report['imported']) != 3 or report['unresolvedImages']:
            raise RuntimeError('Incomplete guide import; inspect its retained report.')
        by_id = {item['id']: item for item in report['imported']}
        hashes = {path: catalog.source_hash(raw) for path, raw in payloads
                  if path.endswith('.md')}
        documents = {}
        for outcome in report['outcomes']:
            if outcome.get('id') in by_id:
                item = by_id[outcome['id']]
                documents[outcome['path']] = {
                    **{key: item[key] for key in ('id', 'title', 'version', 'status')},
                    'sourceHash': hashes[outcome['path']],
                }
        if set(documents) != set(hashes):
            raise RuntimeError('Guide import receipts are incomplete.')
        state['documents'] = documents
        state['reportId'] = report['id']
        helper.save_marker(marker, state)
    urls = []
    for slug in GUIDES:
        name = 'field-guides/' + slug + '.md'
        receipt = state['documents'][name]
        item = client.call('GET', '/api/documents/' + receipt['id'])
        if (item['title'] != receipt['title'] or
                catalog.source_hash(item['source']) != receipt['sourceHash']):
            raise RuntimeError('An owned guide was edited; automatic publication stopped.')
        recovered = (receipt['status'] == 'draft' and item['status'] == 'published'
                     and item['version'] == receipt['version'] + 1)
        if not recovered and (item['status'] != receipt['status'] or
                              item['version'] != receipt['version']):
            raise RuntimeError('An owned guide version changed; review it manually.')
        if item['status'] == 'draft':
            item = helper.publish(client, item)
        if item['status'] != 'published':
            raise RuntimeError('Guide is not available for publication.')
        state['documents'][name] = {
            **{key: item[key] for key in ('id', 'title', 'version', 'status')},
            'sourceHash': receipt['sourceHash'],
        }
        helper.save_marker(marker, state)
        route = routes[slug]
        update = attach_input(route, slug, item['id'])
        if update:
            client.call('PUT', '/api/learning-paths/' + route['id'], update)
        urls.append(client.origin + '/articles/' + item['id'] + '/?path=' + route['id'])
    state['complete'] = True
    helper.save_marker(marker, state)
    return {'publishedGuides': 3, 'existingArticlesReplaced': 0, 'urls': urls}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--examples', type=Path, required=True)
    parser.add_argument('--server-root', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    payloads = load_examples(args.examples)
    if args.dry_run:
        print(json.dumps({'generatedOnly': True, 'guides': 3, 'proseCharacters': {
            path: prose_count(raw.decode()) for path, raw in payloads
            if path.endswith('.md')}}))
        return
    if not args.server_root:
        parser.error('--server-root required outside dry-run')
    catalog, helper = helpers()
    directory = args.server_root / 'showcases'
    with catalog.direction_lock(directory, 'field-guides-v1'):
        marker = directory / 'field-guides-v1.json'
        state = helper.private_json(marker) if marker.exists() else {'requestId': uuid.uuid4().hex}
        if state.get('complete'):
            print(json.dumps({'alreadySeeded': True}))
            return
        helper.save_marker(marker, state)
        client = helper.Client(helper.private_json(args.server_root / 'secrets/access.json'))
        print(json.dumps(publish(client, args.server_root, payloads, marker, state, catalog, helper)))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        print('Guide publication stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
