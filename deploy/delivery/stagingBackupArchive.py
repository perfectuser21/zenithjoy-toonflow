"""Authenticated, compressed cold archives in the private Hong Kong COS prefix."""
import hashlib
import os
import struct
import zlib
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from verifyBusiness import require, rootFile, rootJson


formatName = 'cos-aesgcm-zlib-v1'
chunkSize = 8 * 1024**2
partSize = 32 * 1024**2
magic = b'TFCOLD1\0'


def archiveKey(receipt):
    return f"aivideoReleaseBackups/hk/retention/{receipt['backupId']}/{receipt['capsuleSha256']}.zj"


def encryption(master, salt):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    return AESGCM(HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=magic).derive(master))


def frameIdentity(index, receipt):
    return index.to_bytes(12, 'big'), bytes.fromhex(receipt['capsuleSha256'])


def encodedChunks(capsule, receipt, master):
    salt = os.urandom(16)
    cipher = encryption(master, salt)
    yield magic + salt
    digest, count = hashlib.sha256(), 0
    with capsule.open('rb') as source:
        for index, block in enumerate(iter(lambda: source.read(chunkSize), b'')):
            count += len(block)
            require(count <= receipt['capsuleCapacityBytes'], 'backup exceeds declared size')
            digest.update(block)
            nonce, aad = frameIdentity(index, receipt)
            encrypted = cipher.encrypt(nonce, zlib.compress(block, 3), aad)
            yield struct.pack('>I', len(encrypted)) + encrypted
    require(count == receipt['capsuleCapacityBytes'] and digest.hexdigest() == receipt['capsuleSha256'],
            'backup changed while encoding')


def readExactly(stream, length):
    result = bytearray()
    while len(result) < length:
        block = stream.read(length - len(result))
        require(block, 'truncated archive')
        result.extend(block)
    return bytes(result)


def decodedChunks(stream, receipt, master):
    require(readExactly(stream, len(magic)) == magic, 'unknown archive format')
    cipher = encryption(master, readExactly(stream, 16))
    count, index = 0, 0
    while count < receipt['capsuleCapacityBytes']:
        length = struct.unpack('>I', readExactly(stream, 4))[0]
        require(16 < length <= chunkSize + 65536, 'invalid archive frame size')
        nonce, aad = frameIdentity(index, receipt)
        frame = cipher.decrypt(nonce, readExactly(stream, length), aad)
        decoder = zlib.decompressobj()
        expected = min(chunkSize, receipt['capsuleCapacityBytes'] - count)
        block = decoder.decompress(frame, expected + 1)
        require(len(block) == expected and decoder.eof and not decoder.unused_data, 'invalid archive frame')
        yield block
        index += 1
        count += expected
    require(not stream.read(1), 'unexpected archive trailing data')


def verifyStream(stream, receipt, master, output=None):
    digest = hashlib.sha256()
    for block in decodedChunks(stream, receipt, master):
        digest.update(block)
        if output is not None:
            output.write(block)
    require(digest.hexdigest() == receipt['capsuleSha256'], 'archive readback mismatch')


class CosArchive:
    def __init__(self, path='/etc/aivideo/stagingBackupArchive.json'):
        from qcloud_cos import CosConfig, CosS3Client
        config = rootJson(path, private=True)
        self.bucket = config['bucket']
        self.region = config['region']
        self.master = rootFile(config['keyFile'], private=True).read_bytes()
        require(len(self.master) == 32, 'archive key must be 32 bytes')
        self.client = CosS3Client(CosConfig(Region=self.region, SecretId=config['secretId'],
                                            SecretKey=config['secretKey'], Scheme='https', Timeout=45,
                                            Endpoint='cos-internal.accelerate.tencentcos.cn'))

    def upload(self, capsule, receipt):
        from qcloud_cos.cos_exception import CosServiceError
        key = archiveKey(receipt)
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return
        except CosServiceError as error:
            if error.get_status_code() != 404:
                raise
        multipart = self.client.create_multipart_upload(Bucket=self.bucket, Key=key, ACL='private',
                                                        ForbidOverwrite='true')
        uploadId = multipart['UploadId']
        parts, pending = [], bytearray()

        def put():
            number = len(parts) + 1
            part = self.client.upload_part(Bucket=self.bucket, Key=key, UploadId=uploadId,
                                           PartNumber=number, Body=bytes(pending))
            parts.append({'PartNumber': number, 'ETag': part['ETag']})
            pending.clear()

        try:
            for block in encodedChunks(capsule, receipt, self.master):
                pending.extend(block)
                if len(pending) >= partSize:
                    put()
            if pending:
                put()
            self.client.complete_multipart_upload(Bucket=self.bucket, Key=key, UploadId=uploadId,
                                                  MultipartUpload={'Part': parts}, ForbidOverwrite='true')
        except Exception:
            try:
                self.client.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=uploadId)
            except Exception:
                # Published objects are never removed; a failed abort leaves a diagnostic.
                pass
            raise

    def verify(self, receipt, output=None):
        key = archiveKey(receipt)
        try:
            url = f'https://{self.bucket}.cos.{self.region}.myqcloud.com/{key}'
            with urlopen(Request(url, method='HEAD'), timeout=15):
                raise RuntimeError('archive unexpectedly allows anonymous access')
        except HTTPError as error:
            require(error.code in (401, 403), 'cannot confirm archive is private')
        body = self.client.get_object(Bucket=self.bucket, Key=key)['Body'].get_raw_stream()
        try:
            verifyStream(body, receipt, self.master, output)
        finally:
            body.close()
        return {'key': key, 'capsuleSha256': receipt['capsuleSha256'],
                'capsuleCapacityBytes': receipt['capsuleCapacityBytes']}
