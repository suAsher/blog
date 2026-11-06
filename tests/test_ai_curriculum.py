import copy
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_field_guides_flow import FakeClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ai_curriculum', ROOT / 'deploy/seed-ai-curriculum.py')
curriculum = importlib.util.module_from_spec(spec)
spec.loader.exec_module(curriculum)
catalog, real_helper = curriculum.helpers()


def fixtures():
    manifest = {
        'title': '演示 · AI 工程', 'description': '生成演示路线', 'accent': 'blue',
        'objectives': ['理解服务边界'], 'prerequisites': ['基础命令行'],
        'chapters': [{'existingGuide': 'inference', 'title': '序章',
                      'goal': '看清请求全景', 'exercise': '手算首响'}] + [
            {'file': name, 'title': f'第 {index} 章', 'goal': '说明机制',
             'exercise': '记录一次可复现实验'}
            for index, name in enumerate(curriculum.FILES, 1)
        ],
    }
    payloads = [('ai-infrastructure/' + name,
                 ('---\ntitle: "演示 · ' + name + '"\n---\n\n生成演示内容：' + name).encode())
                for name in curriculum.FILES]
    return manifest, payloads


class Helper:
    def __init__(self, route):
        self.route = route
        self.saved = []

    def private_json(self, path):
        if path.name == 'learning-catalog-ai-inference-v1.json':
            return {'pathId': self.route['id']}
        if path.name == 'field-guides-v1.json':
            return {'complete': True, 'documents': {'field-guides/inference.md': {'id': 'e' * 32}}}
        raise AssertionError('Unexpected file ' + str(path))

    def save_marker(self, _marker, value):
        self.saved.append(copy.deepcopy(value))

    def multipart(self, payloads, decisions):
        return (copy.deepcopy(payloads), copy.deepcopy(decisions)), 'multipart/test'

    def publish(self, client, document):
        return client.call('POST', '/api/documents/' + document['id'] + '/publish', {'version': document['version']})


class Client(FakeClient):
    def __init__(self, payloads, route):
        super().__init__(payloads, {'route': route})
        self.lose_route = False
        self.documents['e' * 32] = {'id': 'e' * 32, 'status': 'published', 'version': 2, 'source': '已有导读', 'title': '原导读'}

    def call(self, method, path, data=None, content_type=None):
        value = super().call(method, path, data, content_type)
        if path == '/api/import':
            for item in value['imported']:
                name = next(outcome['path'] for outcome in value['outcomes'] if outcome['id'] == item['id'])
                title = '演示 · ' + Path(name).name
                self.documents[item['id']]['title'] = title
                item['title'] = title
        if self.lose_route and method == 'PUT':
            self.lose_route = False
            raise RuntimeError('lost route response')
        return value


class CurriculumTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.marker = self.root / 'ai-curriculum-v1.json'
        self.manifest, self.payloads = fixtures()
        self.route = {'id': 'c' * 32, 'title': '我的 AI 路线', 'description': '人工维护',
                      'accent': 'violet', 'version': 4, 'objectives': ['我的目标'],
                      'prerequisites': [], 'chapters': [
                          {'id': 'field-guide-inference-v1', 'title': '导读', 'description': '保留',
                           'documentIds': ['e' * 32], 'practiced': True},
                          {'id': 'old', 'title': '原有章', 'description': '', 'documentIds': ['f' * 32]},
                      ]}
        self.helper = Helper(self.route)
        self.client = Client(self.payloads, self.route)
        self.state = {'requestId': 'stable-receipt'}
        self.helper.save_marker(self.marker, self.state)

    def tearDown(self):
        self.temp.cleanup()

    def run_seed(self, state=None):
        return curriculum.publish(self.client, self.root, self.manifest, self.payloads,
                                  self.marker, self.state if state is None else state,
                                  catalog, self.helper)

    def assert_complete(self):
        self.assertTrue(self.helper.saved[-1]['complete'])
        self.assertEqual(len(self.client.documents), 7)
        self.assertEqual(len(self.client.publish_calls), 6)
        route = self.client.routes[self.route['id']]
        self.assertEqual(route['title'], self.route['title'])
        self.assertEqual(route['objectives'], ['我的目标'])
        self.assertEqual(route['prerequisites'], ['基础命令行'])
        self.assertEqual(route['chapters'][0], {**self.route['chapters'][0],
                         'goal': '看清请求全景', 'exercise': '手算首响'})
        self.assertEqual(route['chapters'][7], self.route['chapters'][1])

    def test_six_create_only_articles_extend_existing_route_without_replacing_it(self):
        result = self.run_seed()
        self.assertEqual(result['publishedArticles'], 6)
        self.assertEqual(result['existingArticlesReplaced'], 0)
        self.assert_complete()

    def test_lost_import_reuses_stable_receipt(self):
        self.client.lose_import = True
        with self.assertRaisesRegex(RuntimeError, 'lost import'):
            self.run_seed()
        self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        self.assertEqual(self.client.import_ids, ['stable-receipt', 'stable-receipt'])
        self.assert_complete()

    def test_lost_publish_does_not_publish_twice(self):
        self.client.lose_publish = True
        with self.assertRaisesRegex(RuntimeError, 'lost publish'):
            self.run_seed()
        self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        self.assert_complete()

    def test_lost_route_response_recovers_without_duplicate_chapters(self):
        self.client.lose_route = True
        with self.assertRaisesRegex(RuntimeError, 'lost route'):
            self.run_seed()
        self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        self.assertEqual(len(self.client.route_writes), 1)
        self.assert_complete()

    def test_route_conflict_stops_and_retry_preserves_new_manual_chapter(self):
        self.client.conflict_route = True
        with self.assertRaisesRegex(RuntimeError, '409'):
            self.run_seed()
        self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        route = self.client.routes[self.route['id']]
        self.assertEqual(route['chapters'][-1]['id'], 'new-user-chapter')
        self.assertEqual(route['description'], 'another device changed this description')
        self.assert_complete()

    def test_manual_source_edit_stops_before_route_write(self):
        self.client.conflict_route = True
        with self.assertRaisesRegex(RuntimeError, '409'):
            self.run_seed()
        self.client.documents[f'{1:032x}']['source'] += '\n人工改写'
        before = copy.deepcopy(self.client.documents)
        with self.assertRaisesRegex(RuntimeError, 'edited'):
            self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        self.assertEqual(self.client.documents, before)
        self.assertEqual(self.client.route_writes, [])

    def test_changed_fixture_fingerprint_stops_before_import_retry(self):
        self.client.lose_import = True
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.payloads[0] = (self.payloads[0][0], b'changed')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        self.assertEqual(len(self.client.import_ids), 1)

    def test_collision_or_missing_intro_stops_before_import(self):
        for chapters in [[], [{'id': 'ai-engineering-01', 'title': 'manual', 'description': '', 'documentIds': []}]]:
            self.client.routes[self.route['id']]['chapters'] = chapters
            with self.assertRaises(RuntimeError):
                self.run_seed()
        self.assertEqual(self.client.import_ids, [])

    def test_all_reserved_chapter_ids_without_owned_receipts_stop_before_import(self):
        self.client.routes[self.route['id']]['chapters'] += [
            {'id': f'ai-engineering-{index:02}', 'title': '人工章节',
             'description': '', 'documentIds': []} for index in range(1, 7)
        ]
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.assertEqual(self.client.import_ids, [])

    def test_recovered_route_refuses_manual_changes_to_generated_chapters(self):
        self.client.lose_route = True
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.client.routes[self.route['id']]['chapters'][1]['goal'] = '人工补充'
        calls = len(self.client.publish_calls)
        with self.assertRaisesRegex(RuntimeError, 'edited'):
            self.run_seed(copy.deepcopy(self.helper.saved[-1]))
        self.assertEqual(len(self.client.publish_calls), calls)

    def test_manifest_rejects_traversal_and_over_budget_learning_metadata(self):
        variants = []
        for field, value in [('objectives', ['x'] * 9), ('prerequisites', None)]:
            variants.append({**self.manifest, field: value})
        changed = copy.deepcopy(self.manifest)
        changed['chapters'][1]['file'] = '../README.md'
        variants.append(changed)
        changed = copy.deepcopy(self.manifest)
        changed['chapters'][1]['exercise'] = 'x' * 2001
        variants.append(changed)
        changed = copy.deepcopy(self.manifest)
        changed['chapters'][0]['goal'] = 'x' * 801
        variants.append(changed)
        for value in variants:
            with self.assertRaises(RuntimeError):
                curriculum.validate_manifest(value)

    def test_intro_fills_only_empty_learning_fields_and_preserves_manual_goals(self):
        intro = self.client.routes[self.route['id']]['chapters'][0]
        intro['goal'] = '我自己的目标'
        intro['exercise'] = ''
        self.run_seed()
        result = self.client.routes[self.route['id']]['chapters'][0]
        self.assertEqual(result, {**intro, 'exercise': '手算首响'})

    def test_loader_rejects_symlinked_sources_and_titles_outside_frontmatter(self):
        directory = self.root / 'examples'
        directory.mkdir()
        (directory / 'index.json').write_text(json.dumps(self.manifest))
        target = self.root / 'elsewhere.md'
        target.write_text('Not an authorized fixture')
        (directory / curriculum.FILES[0]).symlink_to(target)
        with self.assertRaises(RuntimeError):
            curriculum.load_examples(directory)
        with self.assertRaises(RuntimeError):
            curriculum.article_title('---\ndate: 2026-10-31\n---\ntitle: "演示 · fake"'.encode())

    def test_real_lock_rejects_concurrency_and_completed_main_never_logs_in(self):
        directory = self.root / 'showcases'
        with catalog.direction_lock(directory, 'ai-curriculum-v1'):
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                with catalog.direction_lock(directory, 'ai-curriculum-v1'):
                    self.fail('Concurrent lock accepted')
        real_helper.save_marker(directory / 'ai-curriculum-v1.json', {'complete': True})
        args = ['seed', '--examples', '/unused', '--server-root', str(self.root)]
        with patch.object(curriculum, 'load_examples', return_value=(self.manifest, self.payloads)), \
                patch('sys.argv', args), redirect_stdout(io.StringIO()) as output:
            curriculum.main()
        self.assertIn('alreadySeeded', output.getvalue())

    def test_loader_accepts_only_the_six_fixed_substantive_markdown_files(self):
        directory = self.root / 'examples'
        directory.mkdir()
        (directory / 'index.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        for name in curriculum.FILES:
            source = '---\ntitle: "演示 · ' + name + '"\n---\n生成演示\n' + '机制推演' * 550 + '\n```python\nassert True\n```\n'
            (directory / name).write_text(source, encoding='utf-8')
        (directory / 'README.md').write_text('Never imported')
        manifest, payloads = curriculum.load_examples(directory)
        self.assertEqual(len(payloads), 6)
        self.assertEqual(manifest, self.manifest)
        (directory / curriculum.FILES[0]).write_text('short')
        with self.assertRaises(RuntimeError):
            curriculum.load_examples(directory)


if __name__ == '__main__':
    unittest.main()
