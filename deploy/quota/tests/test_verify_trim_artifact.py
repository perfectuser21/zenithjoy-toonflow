import importlib.util
import hashlib
import io
import json
import tarfile
import zipfile
import pathlib
import stat
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'verifyTrimArtifact.py'
spec = importlib.util.spec_from_file_location('verify_trim_artifact', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ArtifactIdentityTests(unittest.TestCase):
    def setUp(self):
        self.pin = {'repository': 'perfectuser21/zenithjoy-toonflow', 'workflow': '.github/workflows/serverBuild.yml', 'run_id': 42, 'run_attempt': 1, 'commit': 'a' * 40, 'artifact_id': 43, 'artifact_digest': 'sha256:' + 'b' * 64}
        self.run = {'id': 42, 'run_attempt': 1, 'path': self.pin['workflow'], 'event': 'pull_request', 'status': 'completed', 'conclusion': 'success', 'head_sha': self.pin['commit'], 'repository': {'full_name': self.pin['repository']}, 'head_repository': {'full_name': self.pin['repository']}}
        self.artifacts = [{'id': 43, 'name': 'toonflow-build-' + self.pin['commit'], 'digest': self.pin['artifact_digest'], 'expired': False, 'size_in_bytes': 100}]
    def test_exact_pinned_identity(self):
        m.verify_github_identity(self.pin, self.run, self.artifacts)
    def test_reject_wrong_commit_workflow_or_unsuccessful_run(self):
        for field, value in [('head_sha', 'c' * 40), ('path', '.github/workflows/other.yml'), ('conclusion', 'failure'), ('event', 'push'), ('run_attempt', 2)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                m.verify_github_identity(self.pin, {**self.run, field: value}, self.artifacts)
    def test_reject_artifact_swap_duplicate_expiry_and_digest(self):
        for rows in [[], self.artifacts * 2, [{**self.artifacts[0], 'expired': True}], [{**self.artifacts[0], 'digest': 'sha256:'+'c'*64}], [{**self.artifacts[0], 'id': 99}], [{**self.artifacts[0], 'size_in_bytes': 0}], [{**self.artifacts[0], 'size_in_bytes': 3 * 1024**3}]]:
            with self.assertRaises(ValueError): m.verify_github_identity(self.pin, self.run, rows)
    def test_artifact_bytes_must_match_independent_pin(self):
        payload = b'authenticated synthetic archive bytes'
        pin = {**self.pin, 'artifact_digest': 'sha256:' + hashlib.sha256(payload).hexdigest()}
        m.verify_artifact_digest(pin, io.BytesIO(payload))
        with self.assertRaises(ValueError): m.verify_artifact_digest(pin, io.BytesIO(payload + b'!'))
    def make_archive(self, *, source=None, unit_map=None, evil=False, wrong_unit=False, conflict=False, complete=False):
        code = b'worker'
        manifest = {'source_sha': source or self.pin['commit'], 'repository': self.pin['repository'], 'run_id': str(self.pin['run_id']), 'run_attempt': str(self.pin['run_attempt']), 'architecture': 'linux/amd64', 'files_sha256': {'server/trimWorker.js': hashlib.sha256(code).hexdigest()}, 'unit_sources_sha256': unit_map if unit_map is not None else {x: hashlib.sha256(b'unit').hexdigest() for x in m.REQUIRED_UNITS}}
        if complete:
            for name in ('captureTrimRuntimeProof.js','recoverTrimActive.js','prepareTrimCgroup.js'):
                manifest['files_sha256']['server/'+name] = hashlib.sha256(name.encode()).hexdigest()
        t = io.BytesIO()
        with tarfile.open(fileobj=t, mode='w:gz') as tf:
            def add(name, payload):
                item = tarfile.TarInfo(name); item.size = len(payload); tf.addfile(item, io.BytesIO(payload))
            add('build/server/trimWorker.js', code)
            if complete:
                for name in ('captureTrimRuntimeProof.js','recoverTrimActive.js','prepareTrimCgroup.js'):
                    add('build/server/'+name, name.encode())
            for path in m.REQUIRED_UNITS:
                add('release-units/' + pathlib.PurePosixPath(path).name, b'evil' if wrong_unit else b'unit')
            add('artifact-manifest.json', json.dumps(manifest).encode())
            if conflict:
                add('build/server/trimWorker.js/child', b'x')
            if evil:
                item=tarfile.TarInfo('build/server/evil'); item.type=tarfile.SYMTYPE; item.linkname='/etc/passwd'; tf.addfile(item)
        inner=t.getvalue(); z=io.BytesIO()
        with zipfile.ZipFile(z,'w') as zf:
            zf.writestr('toonflow-build.tar.gz',inner)
            zf.writestr('toonflow-build.tar.gz.sha256',hashlib.sha256(inner).hexdigest()+'  toonflow-build.tar.gz\n')
        return z.getvalue()
    def test_artifact_contents_bind_ci_and_reject_symlink(self):
        payload=self.make_archive()
        pin={**self.pin, 'artifact_digest':'sha256:'+hashlib.sha256(payload).hexdigest()}
        m.verify_artifact_contents(pin, io.BytesIO(payload))
        for payload in [self.make_archive(source='c'*40), self.make_archive(unit_map={}), self.make_archive(evil=True), self.make_archive(wrong_unit=True), self.make_archive(conflict=True)]:
            pin={**self.pin, 'artifact_digest':'sha256:'+hashlib.sha256(payload).hexdigest()}
            with self.assertRaises(ValueError):m.verify_artifact_contents(pin, io.BytesIO(payload))
    def test_outer_zip_rejects_oversized_checksum_and_symlink(self):
        for symlink in (False, True):
            z=io.BytesIO()
            with zipfile.ZipFile(z,'w') as f:
                info=zipfile.ZipInfo('toonflow-build.tar.gz')
                if symlink: info.external_attr=(stat.S_IFLNK | 0o777) << 16
                f.writestr(info,b'test')
                f.writestr('toonflow-build.tar.gz.sha256',b'x' * (1 if symlink else 257))
            payload=z.getvalue(); pin={**self.pin, 'artifact_digest':'sha256:'+hashlib.sha256(payload).hexdigest()}
            with self.assertRaises(ValueError):m.verify_artifact_contents(pin,io.BytesIO(payload))
    def test_installed_unit_and_worker_must_equal_verified_manifest(self):
        units = {x: hashlib.sha256(('bytes:' + x).encode()).hexdigest() for x in m.REQUIRED_UNITS}
        files = {'server/trimWorker.js': hashlib.sha256(b'worker').hexdigest(), 'server/captureTrimRuntimeProof.js': hashlib.sha256(b'witness').hexdigest(), 'server/recoverTrimActive.js': hashlib.sha256(b'recovery').hexdigest(), 'server/prepareTrimCgroup.js': hashlib.sha256(b'cgroup').hexdigest()}
        manifest = {'unit_sources_sha256': units, 'files_sha256': files}
        installed = {x: ('bytes:' + x).encode() for x in m.REQUIRED_UNITS} | {'server/trimWorker.js': b'worker', 'server/captureTrimRuntimeProof.js': b'witness', 'server/recoverTrimActive.js': b'recovery', 'server/prepareTrimCgroup.js': b'cgroup'}
        m.verify_installed_bytes(manifest, installed)
        with self.assertRaises(ValueError): m.verify_installed_bytes(manifest, {**installed, m.REQUIRED_UNITS[0]: b'tampered'})
        with self.assertRaises(ValueError): m.verify_installed_bytes(manifest, {k:v for k,v in installed.items() if k != 'server/trimWorker.js'})
    def test_collects_only_verified_install_members(self):
        payload=self.make_archive()
        pin={**self.pin, 'artifact_digest':'sha256:'+hashlib.sha256(payload).hexdigest()}
        with self.assertRaises(ValueError): m.collect_install_members(pin, io.BytesIO(payload))
        payload=self.make_archive(complete=True); pin={**self.pin, 'artifact_digest':'sha256:'+hashlib.sha256(payload).hexdigest()}
        manifest, members=m.collect_install_members(pin,io.BytesIO(payload))
        self.assertEqual(members['server/trimWorker.js'],b'worker')
        m.verify_installed_bytes(manifest,members)
    def test_release_cannot_skip_authenticated_api_identity(self):
        payload=self.make_archive()
        pin={**self.pin, 'artifact_digest':'sha256:'+hashlib.sha256(payload).hexdigest()}
        artifacts=[{**self.artifacts[0], 'digest':pin['artifact_digest']}]
        m.verify_release(pin,self.run,artifacts,io.BytesIO(payload))
        with self.assertRaises(ValueError):m.verify_release(pin,{**self.run,'conclusion':'failure'},artifacts,io.BytesIO(payload))
    def test_reject_unpinned_fields(self):
        with self.assertRaises(ValueError): m.verify_github_identity({**self.pin, 'extra': 'x'}, self.run, self.artifacts)

if __name__ == '__main__': unittest.main()

class ReleasePinGenerationTests(unittest.TestCase):
    def test_pin_digest_only_from_authenticated_selected_artifact(self):
        candidate = {'repository':'perfectuser21/zenithjoy-toonflow', 'workflow':'.github/workflows/serverBuild.yml', 'run_id':42, 'run_attempt':1, 'commit':'a'*40, 'artifact_id':43}
        run = {'id':42, 'run_attempt':1, 'path':candidate['workflow'], 'event':'pull_request', 'status':'completed', 'conclusion':'success', 'head_sha':candidate['commit'], 'repository':{'full_name':candidate['repository']}, 'head_repository':{'full_name':candidate['repository']}}
        row = {'id':43, 'name':'toonflow-build-'+candidate['commit'], 'digest':'sha256:'+'b'*64, 'expired':False, 'size_in_bytes':100}
        result=m.pin_authenticated_candidate(candidate,run,[row])
        self.assertEqual(result['artifact_digest'],row['digest'])
        with self.assertRaises(ValueError):m.pin_authenticated_candidate({**candidate, 'commit':'c'*40},run,[row])
        with self.assertRaises(ValueError):m.pin_authenticated_candidate(candidate,{**run,'conclusion':'failure'},[row])
        with self.assertRaises(ValueError):m.pin_authenticated_candidate({**candidate,'artifact_digest':row['digest']},run,[row])
