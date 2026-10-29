#!/usr/bin/env python3
"""Explicit generated learning catalog; private credentials never leave the server."""
import argparse
from contextlib import contextmanager
import fcntl
import os
import stat
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid
DIRECTIONS = (
    'linux-network', 'python', 'git-engineering', 'containers-delivery',
    'distributed-systems', 'performance-observability', 'ai-inference',
)


def helpers():
    path = Path(__file__).with_name('seed-research-demo.py')
    spec = importlib.util.spec_from_file_location('catalog_helpers', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def body_source(raw):
    value = raw.decode('utf-8') if isinstance(raw, bytes) else raw
    body = re.sub(r'\A---\r?\n.*?\r?\n---\r?\n', '', value, count=1, flags=re.S)
    return body.replace('\r\n', '\n').strip()


def text(value, limit, required=False):
    return (
        isinstance(value, str)
        and len(value) <= limit
        and (not required or value.strip())
    )


def checked_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise RuntimeError('Unsafe or oversized generated fixture.')
    return path.read_bytes()


def valid_manifest(value):
    return (
        isinstance(value, dict)
        and text(value.get('title'), 160, True)
        and '演示' in value['title']
        and text(value.get('description'), 4000)
        and value.get('accent') in ('mint', 'blue', 'violet')
        and isinstance(value.get('chapters'), list)
        and len(value['chapters']) == 3
    )


def valid_chapter(value):
    return (
        isinstance(value, dict)
        and isinstance(value.get('id'), str)
        and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value['id'])
        and text(value.get('title'), 160, True)
        and text(value.get('description'), 2000)
        and isinstance(value.get('lessons'), list)
        and len(value['lessons']) == 2
    )


def valid_lesson(value):
    return (
        isinstance(value, dict)
        and text(value.get('title'), 160, True)
        and value['title'].startswith('演示 ·')
        and text(value.get('description'), 4000)
        and isinstance(value.get('file'), str)
        and re.fullmatch(r'[0-9]{2}-[a-z-]+\.md', value['file'])
    )


def load_examples(root, slug):
    if slug not in DIRECTIONS:
        raise RuntimeError('Unknown explicit catalog direction.')
    directory = root / slug
    if root.is_symlink() or directory.is_symlink() or (not directory.is_dir()):
        raise RuntimeError('Unsafe generated direction directory.')
    manifest = json.loads(checked_file(directory / 'index.json'))
    if not valid_manifest(manifest):
        raise RuntimeError('Expected a three-chapter generated direction.')
    (payloads, files, chapters, titles) = ([], set(), set(), set())
    for chapter in manifest['chapters']:
        if not valid_chapter(chapter) or chapter['id'] in chapters:
            raise RuntimeError('Invalid generated chapter structure.')
        chapters.add(chapter['id'])
        for lesson in chapter['lessons']:
            if not valid_lesson(lesson) or lesson['title'] in titles or lesson['file'] in files:
                raise RuntimeError('Unsafe, duplicate or invalid generated lesson.')
            files.add(lesson['file'])
            titles.add(lesson['title'])
            raw = checked_file(directory / lesson['file'])
            source = raw.decode('utf-8')
            body = body_source(raw)
            enough_prose = len(re.findall(r'[\u4e00-\u9fff]', body)) >= 450
            matching_title = f'title: "{lesson["title"]}"' in source
            if (
                '生成演示内容' not in body or not enough_prose
                or not matching_title or '```' not in body
            ):
                raise RuntimeError(
                    'Generated notice, matching metadata or substantive article missing: '
                    + slug + '/' + lesson['file']
                )
            payloads.append(('learning-' + slug + '/' + lesson['file'], raw))
    return (manifest, payloads)

def source_hash(source):
    return hashlib.sha256(body_source(source).encode()).hexdigest()

def path_input(slug, manifest, documents):
    chapters = []
    for chapter in manifest['chapters']:
        ids = []
        for lesson in chapter['lessons']:
            source_path = 'learning-' + slug + '/' + lesson['file']
            ids.append(documents[source_path]['id'])
        chapters.append({
            **{key: chapter[key] for key in ('id', 'title', 'description')},
            'documentIds': ids,
        })
    return {
        **{key: manifest[key] for key in ('title', 'description', 'accent')},
        'chapters': chapters,
    }


def seed(client, slug, manifest, payloads, marker, state, helper):
    if state.get('complete'):
        return {'direction': slug, 'alreadySeeded': True}
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode()
    source_bytes = b''.join(raw for _, raw in payloads)
    fingerprint = hashlib.sha256(manifest_bytes + source_bytes).hexdigest()
    if state.get('fingerprint') not in (None, fingerprint):
        raise RuntimeError(
            'Generated fixtures changed during an unfinished seed; review its private marker.'
        )
    state['fingerprint'] = fingerprint
    helper.save_marker(marker, state)
    expected = {
        'learning-' + slug + '/' + lesson['file']: lesson['title']
        for chapter in manifest['chapters'] for lesson in chapter['lessons']
    }
    hashes = {path: source_hash(raw) for (path, raw) in payloads}
    if 'documents' not in state:
        decisions = {
            'requestId': state['requestId'],
            'paths': [{'path': path, 'action': 'create'} for path, _ in payloads],
        }
        body, mime = helper.multipart(payloads, decisions)
        report = client.call('POST', '/api/import', body, mime)
        if len(report['imported']) != 6 or report['unresolvedImages']:
            raise RuntimeError(
                'Incomplete generated import. Inspect its retained import report; '
                'no user document was replaced.'
            )
        summaries = {item['id']: item for item in report['imported']}
        documents = {}
        for outcome in report['outcomes']:
            if outcome.get('id') in summaries:
                value = summaries[outcome['id']]
                documents[outcome['path']] = {
                    **{key: value[key] for key in ('id', 'title', 'status', 'version')},
                    'sourceHash': hashes[outcome['path']],
                }
        if set(documents) != set(expected):
            raise RuntimeError('Incomplete generated import receipts.')
        state['documents'] = documents
        state['reportId'] = report['id']
        helper.save_marker(marker, state)
    for (filename, receipt) in list(state['documents'].items()):
        current = client.call('GET', '/api/documents/' + receipt['id'])
        if (
            current['title'] != expected.get(filename)
            or source_hash(current['source']) != receipt['sourceHash']
        ):
            raise RuntimeError(
                'An owned generated document was edited; automatic publishing stopped.'
            )
        lost_response = (
            receipt['status'] == 'draft' and current['status'] == 'published'
            and current['version'] == receipt['version'] + 1
        )
        if not lost_response and (
            current['version'] != receipt['version']
            or current['status'] != receipt['status']
        ):
            raise RuntimeError(
                'An owned generated document was edited or withdrawn; review it manually.'
            )
        if current['status'] == 'draft':
            current = client.call(
                'POST', '/api/documents/' + receipt['id'] + '/publish',
                {'version': current['version']},
            )
        if current['status'] != 'published':
            raise RuntimeError('Generated document is not publishable.')
        state['documents'][filename] = {
            **{key: current[key] for key in ('id', 'title', 'status', 'version')},
            'sourceHash': receipt['sourceHash'],
        }
        helper.save_marker(marker, state)
    value = path_input(slug, manifest, state['documents'])
    if 'pathId' not in state:
        paths = client.call('GET', '/api/learning-paths')['paths']
        matches = [
            path for path in paths
            if all(path.get(key) == data for key, data in value.items())
        ]
        if len(matches) > 1:
            raise RuntimeError('Multiple matching generated routes require review.')
        path = matches[0] if matches else client.call('POST', '/api/learning-paths', value)
        state['pathId'] = path['id']
        helper.save_marker(marker, state)
    state['complete'] = True
    helper.save_marker(marker, state)
    return {
        'direction': slug, 'published': 6, 'chapters': 3,
        'learningURL': client.origin + '/learn/?id=' + state['pathId'],
    }

@contextmanager
def direction_lock(directory, slug):
    """Lock a persistent inode before reading a marker or generating its receipt."""
    if slug not in DIRECTIONS:
        raise RuntimeError('Unknown catalog lock direction.')
    directory.mkdir(mode=0o700, exist_ok=True)
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        info = os.fstat(directory_fd)
        if info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise RuntimeError('Unsafe catalog lock directory.')
        name = '.learning-catalog-' + slug + '.lock'
        descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                             0o600, dir_fd=directory_fd)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or info.st_uid != os.geteuid()):
            raise RuntimeError('Unsafe catalog lock file.')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                'Catalog direction is busy; retry later with its existing marker.'
            ) from None
        yield
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory_fd)
    # Keep the inode: deleting a lock file would let concurrent runs bypass it.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--examples-root', type=Path, required=True)
    parser.add_argument('--server-root', type=Path)
    parser.add_argument('--direction', choices=DIRECTIONS, action='append')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    directions = args.direction or DIRECTIONS
    if len(set(directions)) != len(directions):
        parser.error('Duplicate direction selected.')
    loaded = [(slug, *load_examples(args.examples_root, slug)) for slug in directions]
    if args.dry_run:
        summary = {
            'generatedOnly': True, 'directions': len(loaded),
            'chapters': len(loaded) * 3, 'articles': len(loaded) * 6,
            'sourceBytes': sum(
                len(raw) for _, _, payloads in loaded for _, raw in payloads
            ),
        }
        print(json.dumps(summary))
        return
    if not args.server_root:
        parser.error('--server-root required outside --dry-run')
    helper = helpers()
    client = None
    for (slug, manifest, payloads) in loaded:
        directory = args.server_root / 'showcases'
        with direction_lock(directory, slug):
            marker = directory / ('learning-catalog-' + slug + '-v1.json')
            state = (
                helper.private_json(marker) if marker.exists()
                else {'requestId': uuid.uuid4().hex}
            )
            if state.get('complete'):
                print(json.dumps({'direction': slug, 'alreadySeeded': True}))
                continue
            helper.save_marker(marker, state)
            if client is None:
                credentials = helper.private_json(args.server_root / 'secrets/access.json')
                client = helper.Client(credentials)
            print(json.dumps(seed(client, slug, manifest, payloads, marker, state, helper)))
if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        message = str(error)
        if '413' in message:
            message += (
                ' Capacity or request budget reached; inspect storage '
                'and the retained report before retrying.'
            )
        if '429' in message:
            message += (
                ' Request rate or import slot is busy; '
                'retry later with the same private marker.'
            )
        print('Catalog setup stopped: ' + message, file=sys.stderr)
        sys.exit(1)
