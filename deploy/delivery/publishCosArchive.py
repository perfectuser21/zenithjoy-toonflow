#!/usr/bin/env python3
"""固定候选镜像构建私有 COS 归档；不输出凭据。"""
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

from imageTransfer import verifyArchive

maximum = 768 * 1024 * 1024
imagePattern = r'ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}'


def main():
    from qcloud_cos import CosConfig, CosS3Client
    logging.disable(logging.CRITICAL)
    image=os.environ['CANDIDATE_IMAGE']; sha=os.environ['GITHUB_SHA']
    run=os.environ['GITHUB_RUN_ID']; attempt=os.environ['GITHUB_RUN_ATTEMPT']
    bucket=os.environ['CANVAS_COS_BUCKET']; region=os.environ['CANVAS_COS_REGION']
    if not re.fullmatch(imagePattern,image) or not re.fullmatch(r'[a-f0-9]{40}',sha):
        raise RuntimeError('candidate identity invalid')
    if not all(re.fullmatch(r'[1-9][0-9]{0,19}',v) for v in (run,attempt)):
        raise RuntimeError('run identity invalid')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,61}-[0-9]{6,20}',bucket) or not re.fullmatch(r'ap-[a-z0-9-]+',region):
        raise RuntimeError('COS identity invalid')
    key=f'aivideoReleases/{sha}/{run}/{attempt}/image.oci'
    with tempfile.TemporaryDirectory(prefix='candidate-oci-') as temporary:
        root=Path(temporary); layout=root/'layout'; archive=root/'image.oci'
        # 使用 docker/login-action 的私有 authfile，不在参数或日志中传递认证值。
        subprocess.run(['skopeo','copy','--all','--preserve-digests','--src-authfile',str(Path.home()/'.docker/config.json'),
                        'docker://'+image,'oci:'+str(layout)+':candidate'],check=True,timeout=1800,
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                       env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'LANG':'C.UTF-8'})
        index=json.loads((layout/'index.json').read_text())
        if index.get('schemaVersion')!=2 or len(index.get('manifests',[]))!=1:
            raise RuntimeError('OCI index invalid')
        descriptor=index['manifests'][0]
        if descriptor.get('digest')!=image.split('@')[1]:
            raise RuntimeError('OCI root digest mismatch')
        descriptor['annotations']={'io.containerd.image.name':image,'org.opencontainers.image.ref.name':'@'+image.split('@')[1]}
        (layout/'index.json').write_text(json.dumps(index,separators=(',',':')))
        names=['oci-layout','index.json']
        blobDir=layout/'blobs'/'sha256'
        for entry in sorted(blobDir.iterdir()):
            if not entry.is_file() or entry.is_symlink() or not re.fullmatch(r'[a-f0-9]{64}',entry.name):
                raise RuntimeError('OCI blob path invalid')
            names.append('blobs/sha256/'+entry.name)
        with tarfile.open(archive,'x',format=tarfile.USTAR_FORMAT) as output:
            for name in names:
                source=layout/name; info=tarfile.TarInfo(name); info.size=source.stat().st_size; info.mode=0o600
                with source.open('rb') as content: output.addfile(info,content)
        size=archive.stat().st_size
        verifyArchive(archive,{'image':image,'sourceSha':sha},maximum)
        digest=hashlib.sha256()
        with archive.open('rb') as content:
            while block:=content.read(1024*1024): digest.update(block)
        client=CosS3Client(CosConfig(Region=region,SecretId=os.environ['CANVAS_COS_SECRET_ID'],
                                     SecretKey=os.environ['CANVAS_COS_SECRET_KEY'],Scheme='https',
                                     EnableOldDomain=True,AllowRedirects=False,Timeout=60),retry=0)
        # 当前 run/attempt 独有 key；不允许复用已存在对象。
        from qcloud_cos.cos_exception import CosServiceError
        try:
            metadata=client.head_object(Bucket=bucket,Key=key)
        except CosServiceError as error:
            if error.get_status_code()!=404: raise
            with archive.open('rb') as content:
                client.put_object(Bucket=bucket,Key=key,Body=content,ACL='private',ContentLength=str(size),
                                  Metadata={'x-cos-meta-sha256':digest.hexdigest()},
                                  ForbidOverwrite='true',EnableMD5=True)
            metadata=client.head_object(Bucket=bucket,Key=key)
        else:
            if int(metadata['Content-Length'])!=size or metadata.get('x-cos-meta-sha256')!=digest.hexdigest():
                raise RuntimeError('COS existing object identity mismatch')
        if int(metadata['Content-Length'])!=size or metadata.get('x-cos-meta-sha256')!=digest.hexdigest():
            raise RuntimeError('COS object identity mismatch')
        with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as output:
            output.write(f'key={key}\nsha256={digest.hexdigest()}\nbytes={size}\n')


if __name__=='__main__':
    try:
        main()
    except Exception:
        raise SystemExit('候选 COS 归档未完成；未输出凭据。')
