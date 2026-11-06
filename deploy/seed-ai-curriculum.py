#!/usr/bin/env python3
"""Append six original AI engineering chapters to an existing private route."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

FILES = (
    '01-contract.md', '02-load-model.md', '03-memory-budget.md',
    '04-admission-batching.md', '05-reliability.md', '06-capstone.md',
)
LOCK_SCOPE = 'ai-curriculum-v1'


def helpers():
    spec = importlib.util.spec_from_file_location(
        'ai_catalog_helpers', Path(__file__).with_name('seed-learning-catalog.py'))
    catalog = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(catalog)
    return catalog, catalog.helpers()


def bounded_text(value, limit, required=True):
    return isinstance(value, str) and len(value) <= limit and (not required or bool(value.strip()))


def checked_bytes(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise RuntimeError('Unsafe or oversized generated fixture: ' + path.name)
    return path.read_bytes()


def article_title(raw):
    frontmatter = re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)', raw.decode('utf-8'), re.S)
    match = re.search(r'^title: "([^"\r\n]{1,160})"$',
                      frontmatter[1], re.M) if frontmatter else None
    if not match or not match[1].startswith('演示 ·'):
        raise RuntimeError('Generated article title required.')
    return match[1]


def prose_count(raw):
    source = raw.decode('utf-8')
    source = re.sub(r'\A---\r?\n.*?\r?\n---\r?\n', '', source, count=1, flags=re.S)
    source = re.sub(r'(?ms)^```[^\n]*\n.*?^```[^\n]*$', '', source)
    return len(re.findall(r'[\u4e00-\u9fff]', source))


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise RuntimeError('Expected a generated curriculum manifest.')
    if (not bounded_text(manifest.get('title'), 160)
            or '演示' not in manifest['title']
            or not bounded_text(manifest.get('description'), 4000)
            or manifest.get('accent') not in ('mint', 'blue', 'violet')):
        raise RuntimeError('Invalid generated route metadata.')
    for key in ('objectives', 'prerequisites'):
        values = manifest.get(key)
        if not isinstance(values, list) or not 1 <= len(values) <= 8 or not all(
                bounded_text(value, 240) for value in values):
            raise RuntimeError('Invalid generated learning goals.')
    chapters = manifest.get('chapters')
    if (not isinstance(chapters, list) or len(chapters) != 7
            or not isinstance(chapters[0], dict)
            or chapters[0].get('existingGuide') != 'inference'
            or not bounded_text(chapters[0].get('title'), 160)
            or not bounded_text(chapters[0].get('goal'), 800)
            or not bounded_text(chapters[0].get('exercise'), 2000)):
        raise RuntimeError('Expected an existing introduction and six chapters.')
    for chapter, name in zip(chapters[1:], FILES):
        if (not isinstance(chapter, dict) or chapter.get('file') != name
                or not bounded_text(chapter.get('title'), 160)
                or not bounded_text(chapter.get('goal'), 800)
                or not bounded_text(chapter.get('exercise'), 2000)):
            raise RuntimeError('Invalid generated chapter or file order.')


def load_examples(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError('Unsafe generated curriculum directory.')
    manifest = json.loads(checked_bytes(directory / 'index.json', 65536))
    validate_manifest(manifest)
    payloads = []
    for name in FILES:
        raw = checked_bytes(directory / name, 131072)
        article_title(raw)
        if prose_count(raw) < 2000 or '生成演示' not in raw.decode('utf-8'):
            raise RuntimeError('Substantive original generated prose required: ' + name)
        payloads.append(('ai-infrastructure/' + name, raw))
    return manifest, payloads


def generated_chapters(manifest, documents):
    return [{
        'id': 'ai-engineering-' + str(index).zfill(2),
        'title': chapter['title'], 'description': chapter['goal'],
        'goal': chapter['goal'], 'exercise': chapter['exercise'],
        'practiced': False,
        'documentIds': [documents['ai-infrastructure/' + chapter['file']]['id']],
    } for index, chapter in enumerate(manifest['chapters'][1:], 1)]


def preflight_route(path, intro_id):
    chapters = path['chapters']
    matches = [index for index, chapter in enumerate(chapters) if intro_id in chapter['documentIds']]
    if len(matches) != 1:
        raise RuntimeError('The existing introduction must belong to one route chapter.')
    generated = [chapter for chapter in chapters if chapter['id'] in {
        'ai-engineering-' + str(index).zfill(2) for index in range(1, 7)
    }]
    if generated and len(generated) != 6:
        raise RuntimeError('Generated chapter identifiers collide with an edited route.')
    if len(chapters) + (0 if generated else 6) > 30:
        raise RuntimeError('Route chapter budget reached.')
    count = sum(len(chapter['documentIds']) for chapter in chapters)
    if count + (0 if generated else 6) > 300:
        raise RuntimeError('Route article budget reached.')
    return matches[0], generated


def attach_input(path, intro_id, manifest, documents):
    index, existing = preflight_route(path, intro_id)
    additions = generated_chapters(manifest, documents)
    intro = path['chapters'][index]
    updated_intro = {**intro, **{
        key: manifest['chapters'][0][key] for key in ('goal', 'exercise')
        if not intro.get(key)
    }}
    updated_chapters = [*path['chapters'][:index], updated_intro, *path['chapters'][index + 1:]]
    metadata = {key: path.get(key) or manifest[key]
                for key in ('objectives', 'prerequisites')}
    if existing:
        actual = {chapter['id']: chapter for chapter in existing}
        for chapter in additions:
            if any(actual[chapter['id']].get(key) != value for key, value in chapter.items()
                   if key != 'practiced'):
                raise RuntimeError('A generated chapter was edited; review its route manually.')
        if updated_intro == intro and all(path.get(key) == value for key, value in metadata.items()):
            return None
    else:
        prior_ids = {doc for chapter in path['chapters'] for doc in chapter['documentIds']}
        if any(chapter['documentIds'][0] in prior_ids for chapter in additions):
            raise RuntimeError('Generated documents were arranged manually; review the route.')
        updated_chapters = [*updated_chapters[:index + 1], *additions, *updated_chapters[index + 1:]]
    return {
        **{key: path[key] for key in ('title', 'description', 'accent', 'version')},
        **metadata, 'chapters': updated_chapters,
    }


def import_documents(client, payloads, state, catalog, helper):
    body, mime = helper.multipart(payloads, {
        'requestId': state['requestId'],
        'paths': [{'path': name, 'action': 'create'} for name, _ in payloads],
    })
    report = client.call('POST', '/api/import', body, mime)
    if len(report['imported']) != 6 or report['unresolvedImages']:
        raise RuntimeError('Incomplete import; review its retained report before retrying.')
    by_id = {item['id']: item for item in report['imported']}
    hashes = {name: catalog.source_hash(raw) for name, raw in payloads}
    documents = {}
    for outcome in report['outcomes']:
        if outcome.get('id') not in by_id:
            continue
        item = by_id[outcome['id']]
        documents[outcome['path']] = {
            **{key: item[key] for key in ('id', 'title', 'version', 'status')},
            'sourceHash': hashes[outcome['path']],
        }
    if set(documents) != set(hashes) or len(by_id) != 6:
        raise RuntimeError('Incomplete import receipts.')
    return {**state, 'documents': documents, 'reportId': report['id']}


def publish(client, root, manifest, payloads, marker, state, catalog, helper):
    fingerprint = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()
                                 + b''.join(raw for _, raw in payloads)).hexdigest()
    if state.get('fingerprint') not in (None, fingerprint):
        raise RuntimeError('Unfinished generated fixtures changed; review the private receipt.')
    route_id = helper.private_json(root / 'showcases/learning-catalog-ai-inference-v1.json')['pathId']
    guide = helper.private_json(root / 'showcases/field-guides-v1.json')
    intro_id = guide['documents']['field-guides/inference.md']['id']
    if not guide.get('complete') or not all(re.fullmatch(r'[a-f0-9]{32}', value) for value in (route_id, intro_id)):
        raise RuntimeError('Completed existing route and introduction receipts are required.')
    if state.get('pathId', route_id) != route_id or state.get('introId', intro_id) != intro_id:
        raise RuntimeError('Existing route receipts changed during publication.')
    route = client.call('GET', '/api/learning-paths/' + route_id)
    _, existing = preflight_route(route, intro_id)
    if existing and 'documents' not in state:
        raise RuntimeError('Generated chapter identifiers already exist without owned receipts.')
    if 'documents' in state:
        # Detect edited/rearranged route entries before publishing any owned drafts.
        attach_input(route, intro_id, manifest, state['documents'])
    if client.call('GET', '/api/documents/' + intro_id)['status'] != 'published':
        raise RuntimeError('The existing introduction is not published.')
    state = {**state, 'fingerprint': fingerprint, 'pathId': route_id, 'introId': intro_id}
    helper.save_marker(marker, state)
    if 'documents' not in state:
        state = import_documents(client, payloads, state, catalog, helper)
        helper.save_marker(marker, state)
    expected = {name: article_title(raw) for name, raw in payloads}
    if set(state['documents']) != set(expected):
        raise RuntimeError('Unexpected owned document receipts.')
    urls = []
    for name, receipt in state['documents'].items():
        item = client.call('GET', '/api/documents/' + receipt['id'])
        if item['title'] != expected[name] or catalog.source_hash(item['source']) != receipt['sourceHash']:
            raise RuntimeError('An owned generated document was edited; publication stopped.')
        recovered = receipt['status'] == 'draft' and item['status'] == 'published' and item['version'] == receipt['version'] + 1
        if not recovered and (item['version'] != receipt['version'] or item['status'] != receipt['status']):
            raise RuntimeError('An owned document was edited or withdrawn; review it manually.')
        if item['status'] == 'draft':
            item = helper.publish(client, item)
        if item['status'] != 'published':
            raise RuntimeError('An owned document is not publishable.')
        state = {**state, 'documents': {**state['documents'], name: {
            **{key: item[key] for key in ('id', 'title', 'version', 'status')},
            'sourceHash': receipt['sourceHash'],
        }}}
        helper.save_marker(marker, state)
        urls.append(client.origin + '/articles/' + item['id'] + '/?path=' + route_id)
    update = attach_input(route, intro_id, manifest, state['documents'])
    if update:
        client.call('PUT', '/api/learning-paths/' + route_id, update)
    helper.save_marker(marker, {**state, 'complete': True})
    return {'publishedArticles': 6, 'existingArticlesReplaced': 0,
            'learningURL': client.origin + '/learn/?id=' + route_id, 'urls': urls}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--examples', type=Path, required=True)
    parser.add_argument('--server-root', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    manifest, payloads = load_examples(args.examples)
    if args.dry_run:
        print(json.dumps({'generatedOnly': True, 'newArticles': 6,
                          'proseCharacters': {name: prose_count(raw) for name, raw in payloads}}))
        return
    if not args.server_root:
        parser.error('--server-root required outside dry-run')
    catalog, helper = helpers()
    directory = args.server_root / 'showcases'
    with catalog.direction_lock(directory, LOCK_SCOPE):
        marker = directory / (LOCK_SCOPE + '.json')
        state = helper.private_json(marker) if marker.exists() else {'requestId': uuid.uuid4().hex}
        if state.get('complete'):
            print(json.dumps({'alreadySeeded': True}))
            return
        helper.save_marker(marker, state)
        client = helper.Client(helper.private_json(args.server_root / 'secrets/access.json'))
        print(json.dumps(publish(client, args.server_root, manifest, payloads, marker, state, catalog, helper)))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        print('Curriculum publication stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
