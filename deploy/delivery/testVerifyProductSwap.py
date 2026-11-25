import hashlib
import unittest
from unittest.mock import patch

from verifyProductSwap import verifySavedSwap


jobId = '4086294d-0421-41fb-b7cd-fc108c3bd5c0'
outputId = 'f33fec2e-d646-49a8-856c-393064161a67'
source = 'assets/source.mp4'
result = 'assets/generated/result.mp4'
canvas = {'nodes': [
    {'type': 'remote-frameAnalysisNode', 'data': {'guidedRemake': {
        'source': source, 'analysis': {'duration': 3},
        'productSwap': {'reference': {'path': 'assets/new.png', 'mimeType': 'image/png'}},
        'job': {'id': jobId, 'phase': 'completed', 'outputId': outputId, 'result': result},
    }}},
    {'id': outputId, 'type': 'remote-videoNode', 'data': {'label': '换品成片',
        'outputs': {'video': {'value': {'url': result, 'mimeType': 'video/mp4'}}}}},
]}


class VerifyProductSwapTest(unittest.TestCase):
    def test_reads_output_twice_and_checks_isolation_without_resuming_a_job(self):
        reads = []

        def read(client, path, expected=200):
            reads.append((client, path, expected))
            return {source: b'old', result: b'new'}[path] if expected == 200 else None

        with patch('verifyProductSwap.verifyVideoTimeline') as timeline:
            receipt = verifySavedSwap(canvas, canvas, jobId, read)
        timeline.assert_called_once_with(b'old', b'new', 3)
        self.assertEqual(receipt['sha256'], hashlib.sha256(b'new').hexdigest())
        self.assertEqual(reads, [(0, source, 200), (0, result, 200), (1, result, 200), (2, result, 403)])

    def test_requires_output_node_in_a_fresh_session_before_reading_media(self):
        with self.assertRaisesRegex(RuntimeError, '输出节点'):
            verifySavedSwap(canvas, {'nodes': canvas['nodes'][:1]}, jobId,
                            lambda *_: self.fail('不应读取媒体'))

    def test_different_bytes_after_login_fail(self):
        with self.assertRaisesRegex(RuntimeError, '读回'):
            verifySavedSwap(canvas, canvas, jobId,
                            lambda client, path, *_: f'{client}/{path}'.encode())


if __name__ == '__main__':
    unittest.main()
