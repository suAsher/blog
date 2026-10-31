import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('field_guides', ROOT / 'deploy/seed-field-guides.py')
guides = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guides)


class FieldGuideTests(unittest.TestCase):
    def test_real_helper_serializes_field_guide_publication(self):
        catalog, _ = guides.helpers()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'showcases'
            with catalog.direction_lock(directory, 'field-guides-v1'):
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    with catalog.direction_lock(directory, 'field-guides-v1'):
                        self.fail('Concurrent publication was allowed')
            with self.assertRaisesRegex(RuntimeError, 'Unknown'):
                with catalog.direction_lock(directory, '../other'):
                    self.fail('Unrecognized lock scope was allowed')

    def test_completed_main_uses_real_lock_and_private_receipt_without_login(self):
        _, helper = guides.helpers()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            helper.save_marker(root / 'showcases/field-guides-v1.json', {'complete': True})
            args = ['seed', '--examples', str(ROOT / 'examples/field-guides'),
                    '--server-root', str(root)]
            # No access.json exists: successful exit proves it never logs in.
            with patch('sys.argv', args), redirect_stdout(io.StringIO()) as output:
                guides.main()
            self.assertIn('alreadySeeded', output.getvalue())

    def test_length_ignores_frontmatter_and_code(self):
        raw = '---\ntitle: "元数据"\n---\n正文\n```python\n' + '中文' * 3000 + '\n```\n'
        self.assertEqual(guides.prose_count(raw), 2)

    def test_route_addition_preserves_existing_chapters_and_fields(self):
        original = {'title': '自定义路线', 'description': '说明', 'accent': 'blue',
                    'version': 4, 'chapters': [{'id': 'old', 'title': '已有章',
                                             'description': '', 'documentIds': ['a' * 32]}]}
        result = guides.attach_input(original, 'inference', 'b' * 32)
        self.assertEqual(len(original['chapters']), 1)
        self.assertEqual(result['chapters'][1], original['chapters'][0])
        self.assertEqual(result['version'], 4)
        self.assertEqual(result['title'], '自定义路线')

    def test_existing_reference_is_not_inserted_again(self):
        original = {'chapters': [{'id': 'user', 'documentIds': ['b' * 32]}]}
        self.assertIsNone(guides.attach_input(original, 'inference', 'b' * 32))

    def test_chapter_collision_stops_instead_of_overwriting(self):
        original = {'chapters': [{'id': 'field-guide-inference-v1', 'documentIds': []}]}
        with self.assertRaises(RuntimeError):
            guides.attach_input(original, 'inference', 'b' * 32)

    def test_unsafe_or_short_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises((RuntimeError, OSError)):
                guides.load_examples(Path(temporary))


if __name__ == '__main__':
    unittest.main()
