import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog', ROOT / 'deploy/seed-learning-catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)

class Helper:

    def __init__(self):
        self.saved = []

    def multipart(self, payloads, decisions):
        return ((payloads, decisions), 'multipart/test')

    def save_marker(self, marker, state):
        self.saved.append(copy.deepcopy(state))

class Client:
    origin = 'https://space.example'

    def __init__(self, manifest, payloads):
        self.documents = {}
        self.paths = []
        self.imports = 0
        self.fail_publish = False
        self.report = {'id': 'report', 'imported': [], 'outcomes': [], 'unresolvedImages': []}
        lessons = [lesson for chapter in manifest['chapters'] for lesson in chapter['lessons']]
        for i, ((path, raw), lesson) in enumerate(zip(payloads, lessons)):
            id = f'{i:032x}'
            doc = {
                'id': id, 'title': lesson['title'], 'status': 'draft',
                'version': 1, 'source': catalog.body_source(raw),
            }
            self.documents[id] = doc
            self.report['imported'].append(copy.deepcopy(doc))
            self.report['outcomes'].append({'path': path, 'id': id})

    def call(self, method, path, data=None, content_type=None):
        if path == '/api/import':
            self.imports += 1
            return copy.deepcopy(self.report)
        if path == '/api/learning-paths':
            if method == 'GET':
                return {'paths': copy.deepcopy(self.paths)}
            result = {**data, 'id': 'a' * 32}
            self.paths.append(result)
            return result
        id = path.split('/')[3]
        doc = self.documents[id]
        if method == 'POST':
            if self.fail_publish:
                self.fail_publish = False
                raise RuntimeError('simulated interrupted response')
            doc = {**doc, 'status': 'published', 'version': doc['version'] + 1}
            self.documents[id] = doc
        return copy.deepcopy(doc)

class CatalogTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.directory = self.root / 'python'
        self.directory.mkdir()
        self.manifest = {
            'title': 'Python（演示）', 'description': '示例路线',
            'accent': 'blue', 'chapters': [],
        }
        for i in range(3):
            lessons = []
            for j in range(2):
                file = f'{i * 2 + j + 1:02}-example.md'
                title = f'演示 · Python {i}-{j}'
                lessons.append({'file': file, 'title': title, 'description': '学习验证'})
                source = (
                    f'---\ntitle: "{title}"\n---\n\n生成演示内容\n\n'
                    + '知识验证' * 130
                    + '\n\n```python\nassert 1 + 1 == 2\n```\n'
                )
                (self.directory / file).write_text(source)
            self.manifest['chapters'].append({
                'id': f'chapter-{i}', 'title': f'第{i + 1}章',
                'description': '', 'lessons': lessons,
            })
        self.write_manifest()

    def tearDown(self):
        self.tmp.cleanup()

    def write_manifest(self):
        (self.directory / 'index.json').write_text(json.dumps(self.manifest, ensure_ascii=False))

    def load(self):
        return catalog.load_examples(self.root, 'python')

    def test_valid_manifest_is_bounded(self):
        (manifest, payloads) = self.load()
        self.assertEqual(len(payloads), 6)
        self.assertEqual(payloads[0][0], 'learning-python/01-example.md')

    def test_rejects_unknown_direction(self):
        with self.assertRaises(RuntimeError):
            catalog.load_examples(self.root, '../python')

    def test_rejects_manifest_symlink(self):
        p = self.directory / 'index.json'
        p.rename(self.root / 'manifest.json')
        p.symlink_to(self.root / 'manifest.json')
        with self.assertRaises(RuntimeError):
            self.load()

    def test_rejects_directory_symlink(self):
        self.directory.rename(self.root / 'actual')
        self.directory.symlink_to(self.root / 'actual', target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.load()

    def test_rejects_unsafe_path_and_duplicate(self):
        for name in ['../escape.md', '01-example.md']:
            self.manifest['chapters'][1]['lessons'][0]['file'] = name
            self.write_manifest()
            with self.assertRaises(RuntimeError):
                self.load()

    def test_rejects_title_mismatch_notice_and_small_article(self):
        file = self.directory / '01-example.md'
        original = file.read_text()
        invalid = [
            original.replace('title: "演示', 'title: "不同'),
            original.replace('生成演示内容', '示例'), original[:100],
        ]
        for source in invalid:
            file.write_text(source)
            with self.assertRaises(RuntimeError):
                self.load()

    def test_rejects_manifest_and_article_size(self):
        file = self.directory / '01-example.md'
        file.write_text('x' * 65537)
        with self.assertRaises(RuntimeError):
            self.load()
        (self.directory / 'index.json').write_text('x' * 65537)
        with self.assertRaises(RuntimeError):
            self.load()

    def test_rejects_wrong_chapter_count_and_accent(self):
        for (key, value) in [('chapters', []), ('accent', 'red')]:
            original = self.manifest[key]
            self.manifest[key] = value
            self.write_manifest()
            with self.assertRaises(RuntimeError):
                self.load()
            self.manifest[key] = original

    def test_seed_completion_is_idempotent(self):
        (manifest, payloads) = self.load()
        client = Client(manifest, payloads)
        helper = Helper()
        state = {'requestId': 'stable'}
        result = catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        self.assertEqual(result['published'], 6)
        self.assertTrue(state['complete'])
        repeated = catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        self.assertTrue(repeated['alreadySeeded'])
        self.assertEqual(client.imports, 1)

    def test_resume_after_publish_failure_does_not_import_again(self):
        (manifest, payloads) = self.load()
        client = Client(manifest, payloads)
        helper = Helper()
        state = {'requestId': 'stable'}
        client.fail_publish = True
        with self.assertRaises(RuntimeError):
            catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        self.assertEqual(client.imports, 1)

    def test_partial_seed_refuses_manually_changed_source(self):
        (manifest, payloads) = self.load()
        client = Client(manifest, payloads)
        helper = Helper()
        state = {'requestId': 'stable'}
        client.fail_publish = True
        with self.assertRaises(RuntimeError):
            catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        client.documents['0' * 32]['source'] += '人工修改'
        with self.assertRaisesRegex(RuntimeError, 'edited'):
            catalog.seed(client, 'python', manifest, payloads, None, state, helper)

    def test_recovers_lost_publish_response_without_republishing(self):
        (manifest, payloads) = self.load()
        client = Client(manifest, payloads)
        helper = Helper()
        state = {'requestId': 'stable'}
        client.fail_publish = True
        with self.assertRaises(RuntimeError):
            catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        first = client.documents['0' * 32]
        first.update(status='published', version=2)
        catalog.seed(client, 'python', manifest, payloads, None, state, helper)
        self.assertEqual(client.documents['0' * 32]['version'], 2)
class CatalogLockTests(unittest.TestCase):
    def test_lock_rejects_concurrent_run_and_is_reusable(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'showcases'
            with catalog.direction_lock(directory, 'python'):
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    with catalog.direction_lock(directory, 'python'):
                        self.fail('Concurrent lock was granted')
            inode = (directory / '.learning-catalog-python.lock').stat().st_ino
            with catalog.direction_lock(directory, 'python'):
                self.assertEqual((directory / '.learning-catalog-python.lock').stat().st_ino, inode)

    def test_lock_refuses_symlink_and_public_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'showcases'
            directory.mkdir(mode=0o700)
            target = Path(temporary) / 'other'
            target.write_text('untouched')
            lock = directory / '.learning-catalog-python.lock'
            lock.symlink_to(target)
            with self.assertRaises(OSError):
                with catalog.direction_lock(directory, 'python'):
                    self.fail('Symlink was accepted')
            self.assertEqual(target.read_text(), 'untouched')
            lock.unlink()
            lock.write_text('')
            lock.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
                with catalog.direction_lock(directory, 'python'):
                    self.fail('Public lock accepted')

if __name__ == '__main__':
    unittest.main()
