import importlib.util
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch

path=pathlib.Path(__file__).resolve().parents[1]/'installFreshTrimRelease.py'
spec=importlib.util.spec_from_file_location('install_trim',path)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class InstallGuardTests(unittest.TestCase):
    def test_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m,'healthy',return_value=True):
            p=str(pathlib.Path(d)/'unit')
            m.write_exclusive(p,b'original',0o600,('/tmp',))
            with self.assertRaises(FileExistsError):m.write_exclusive(p,b'new',0o600,('/tmp',))
            self.assertEqual(pathlib.Path(p).read_bytes(),b'original')
    def test_unresolved_other_artifact_blocks_every_install(self):
        with tempfile.TemporaryDirectory() as d:
            pathlib.Path(d, 'install-11.pending').write_text('pending')
            with self.assertRaises(ValueError): m.require_no_pending(d)
            pathlib.Path(d, 'install-11.pending').unlink()
            pathlib.Path(d, 'install.pending').write_text('pending')
            with self.assertRaises(ValueError): m.require_no_pending(d)
    def test_low_disk_refuses_before_writing(self):
        out=io.BytesIO()
        with patch.object(m,'healthy',return_value=False), self.assertRaises(ValueError):m.write_bytes(out,b'data',('/tmp',))
        self.assertEqual(out.getvalue(),b'')

if __name__=='__main__':unittest.main()
