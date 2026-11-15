import importlib.util
import io
import pathlib
import sys
import unittest

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('fetch_trim_artifact', root / 'fetchTrimArtifact.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class BoundedProcessTests(unittest.TestCase):
    def test_accepts_small_bounded_output(self):
        out = io.BytesIO()
        self.assertEqual(m.run_bounded([sys.executable, '-c', 'print("hello")'], {}, out, 100, 5), 6)
        self.assertEqual(out.getvalue(), b'hello\n')
    def test_rejects_excess_and_timeout_and_low_space(self):
        with self.assertRaises(ValueError): m.run_bounded([sys.executable, '-c', 'print("x" * 1000)'], {}, io.BytesIO(), 10, 5)
        with self.assertRaises(TimeoutError): m.run_bounded([sys.executable, '-c', 'import time; time.sleep(5)'], {}, io.BytesIO(), 100, 0.2)
        with self.assertRaises(ValueError): m.run_bounded([sys.executable, '-c', 'print("x")'], {}, io.BytesIO(), 100, 5, lambda: False)

if __name__ == '__main__': unittest.main()
