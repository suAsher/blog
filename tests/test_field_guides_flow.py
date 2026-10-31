"""Publication recovery tests use in-memory APIs and disposable local paths only."""
from contextlib import nullcontext, redirect_stdout
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'deploy' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


guides = module('field_guides_flow', 'seed-field-guides.py')
catalog = module('field_guides_flow_catalog', 'seed-learning-catalog.py')


class FakeHelper:
    def __init__(self, routes):
        self.routes = routes
        self.saved = []
        self.reads = []

    def private_json(self, path):
        self.reads.append(path)
        for slug in guides.GUIDES:
            if path.name == guides.route_marker(Path('/unused'), slug).name:
                return {'pathId': self.routes[slug]['id']}
        raise AssertionError('Unexpected private file read: ' + path.name)

    def multipart(self, payloads, decisions):
        return (copy.deepcopy(payloads), copy.deepcopy(decisions)), 'multipart/test'

    def save_marker(self, marker, state):
        self.saved.append(copy.deepcopy(state))

    def publish(self, client, document):
        return client.call('POST', '/api/documents/' + document['id'] + '/publish',
                           {'version': document['version']})


class FakeClient:
    origin = 'https://private.example'

    def __init__(self, payloads, routes):
        self.payloads = payloads
        self.routes = {value['id']: copy.deepcopy(value) for value in routes.values()}
        self.documents = {}
        self.receipts = {}
        self.import_ids = []
        self.publish_calls = []
        self.route_writes = []
        self.lose_import = False
        self.lose_publish = False
        self.conflict_route = False

    def call(self, method, path, data=None, content_type=None):
        if path == '/api/import':
            payloads, decisions = data
            request_id = decisions['requestId']
            self.import_ids.append(request_id)
            if request_id not in self.receipts:
                self.assert_create_decisions(payloads, decisions)
                imported, outcomes = [], []
                for index, (name, raw) in enumerate(payloads, 1):
                    document_id = f'{index:032x}'
                    item = {
                        'id': document_id, 'title': '演示 · ' + name,
                        'source': catalog.body_source(raw), 'version': 1, 'status': 'draft',
                    }
                    self.documents[document_id] = item
                    imported.append(copy.deepcopy(item))
                    outcomes.append({'path': name, 'id': document_id})
                self.receipts[request_id] = {
                    'id': 'report-1', 'imported': imported, 'outcomes': outcomes,
                    'unresolvedImages': [],
                }
            if self.lose_import:
                self.lose_import = False
                raise RuntimeError('lost import response')
            return copy.deepcopy(self.receipts[request_id])
        document_id = path.split('/')[3]
        if path.startswith('/api/learning-paths/'):
            if method == 'GET':
                return copy.deepcopy(self.routes[document_id])
            current = self.routes[document_id]
            if self.conflict_route:
                self.conflict_route = False
                current['description'] = 'another device changed this description'
                current['version'] += 1
                current['chapters'].append({
                    'id': 'new-user-chapter', 'title': '人工新增章',
                    'description': '保留', 'documentIds': [],
                })
                raise RuntimeError('409 version conflict')
            if data['version'] != current['version']:
                raise RuntimeError('409 version conflict')
            self.route_writes.append(copy.deepcopy(data))
            self.routes[document_id] = {
                **copy.deepcopy(data), 'id': document_id, 'version': current['version'] + 1,
            }
            return copy.deepcopy(self.routes[document_id])
        item = self.documents[document_id]
        if method == 'POST':
            if data['version'] != item['version']:
                raise RuntimeError('409 document conflict')
            self.publish_calls.append(document_id)
            item = {**item, 'status': 'published', 'version': item['version'] + 1}
            self.documents[document_id] = item
            if self.lose_publish:
                self.lose_publish = False
                raise RuntimeError('lost publish response')
        return copy.deepcopy(item)

    @staticmethod
    def assert_create_decisions(payloads, decisions):
        expected = [{'path': path, 'action': 'create'} for path, _ in payloads]
        if decisions['paths'] != expected:
            raise AssertionError('Publication must never update a preexisting document')


class FieldGuideFlowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.marker = self.root / 'showcases' / 'field-guides-v1.json'
        self.payloads = [
            ('field-guides/' + slug + '.md',
             ('---\ntitle: "演示 · fixture"\n---\n\n生成演示内容：' + slug).encode())
            for slug in guides.GUIDES
        ]
        self.routes = {
            slug: {
                'id': f'{100 + index:032x}', 'title': '路线 ' + slug,
                'description': '原说明', 'accent': 'blue', 'version': 3,
                'chapters': [{
                    'id': 'existing', 'title': '已有章节', 'description': '',
                    'documentIds': ['f' * 32],
                }],
            }
            for index, slug in enumerate(guides.GUIDES)
        }
        self.helper = FakeHelper(self.routes)
        self.client = FakeClient(self.payloads, self.routes)
        self.state = {'requestId': 'stable-field-guide-receipt'}
        self.helper.save_marker(self.marker, self.state)

    def tearDown(self):
        self.temporary.cleanup()

    def publish(self, state=None):
        return guides.publish(
            self.client, self.root, self.payloads, self.marker,
            self.state if state is None else state, catalog, self.helper,
        )

    def assert_completed_without_duplicates(self):
        self.assertTrue(self.helper.saved[-1]['complete'])
        self.assertEqual(len(self.client.documents), 3)
        self.assertEqual(len(self.client.receipts), 1)
        self.assertEqual(len(self.client.publish_calls), 3)
        for path in self.client.routes.values():
            self.assertEqual(len(path['chapters']), 2)
            self.assertEqual(path['chapters'][-1]['id'], 'existing')

    def test_three_create_receipts_publish_and_preserve_prior_chapters(self):
        result = self.publish()
        self.assertEqual(result['publishedGuides'], 3)
        self.assertEqual(result['existingArticlesReplaced'], 0)
        self.assertEqual(len(result['urls']), 3)
        self.assert_completed_without_duplicates()
        self.assertFalse(any(path.name == 'access.json' for path in self.helper.reads))

    def test_lost_import_response_reuses_stable_receipt(self):
        self.client.lose_import = True
        with self.assertRaisesRegex(RuntimeError, 'lost import'):
            self.publish()
        self.publish(copy.deepcopy(self.helper.saved[-1]))
        self.assertEqual(self.client.import_ids, [self.state['requestId']] * 2)
        self.assert_completed_without_duplicates()

    def test_lost_publish_response_does_not_publish_the_same_document_twice(self):
        self.client.lose_publish = True
        with self.assertRaisesRegex(RuntimeError, 'lost publish'):
            self.publish()
        saved = copy.deepcopy(self.helper.saved[-1])
        self.assertEqual(next(iter(saved['documents'].values()))['status'], 'draft')
        self.publish(saved)
        self.assert_completed_without_duplicates()
        self.assertEqual(len(set(self.client.publish_calls)), 3)

    def test_route_conflict_resume_preserves_other_device_changes(self):
        self.client.conflict_route = True
        with self.assertRaisesRegex(RuntimeError, '409'):
            self.publish()
        self.publish(copy.deepcopy(self.helper.saved[-1]))
        first = self.client.routes[self.routes['inference']['id']]
        self.assertEqual(first['description'], 'another device changed this description')
        self.assertEqual(first['version'], 5)
        self.assertEqual([c['id'] for c in first['chapters']], [
            'field-guide-inference-v1', 'existing', 'new-user-chapter',
        ])
        self.assertEqual(len(self.client.documents), 3)
        self.assertEqual(len(self.client.publish_calls), 3)

    def test_manually_edited_source_stops_without_republishing_or_overwriting(self):
        self.client.conflict_route = True
        with self.assertRaisesRegex(RuntimeError, '409'):
            self.publish()
        saved = copy.deepcopy(self.helper.saved[-1])
        item = self.client.documents[f'{1:032x}']
        item['source'] += '\n人工补充，必须保留。'
        item['version'] += 1
        before = copy.deepcopy(self.client.documents)
        calls = len(self.client.publish_calls)
        with self.assertRaisesRegex(RuntimeError, 'edited'):
            self.publish(saved)
        self.assertEqual(self.client.documents, before)
        self.assertEqual(len(self.client.publish_calls), calls)

    def test_completed_main_never_logs_in_or_rewrites(self):
        self.marker.parent.mkdir()
        self.marker.write_text('{}')
        fake_catalog = SimpleNamespace(direction_lock=lambda *_: nullcontext())
        fake_helper = SimpleNamespace(
            private_json=Mock(return_value={'complete': True}),
            Client=Mock(side_effect=AssertionError('Must not log in')),
            save_marker=Mock(side_effect=AssertionError('Must not rewrite marker')),
        )
        arguments = ['seed', '--examples', '/unused', '--server-root', str(self.root)]
        with patch.object(guides, 'load_examples', return_value=self.payloads), \
                patch.object(guides, 'helpers', return_value=(fake_catalog, fake_helper)), \
                patch('sys.argv', arguments), redirect_stdout(io.StringIO()) as output:
            guides.main()
        self.assertIn('alreadySeeded', output.getvalue())
        fake_helper.Client.assert_not_called()
        fake_helper.save_marker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
