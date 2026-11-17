#!/usr/bin/env python3
"""固定候选 OCI 的分阶段私有 COS 发布；日志不包含凭据。"""
from contextlib import contextmanager
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import threading
import time

from imageTransfer import verifyArchive

maximum = 768 * 1024 * 1024
imagePattern = r'ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}'


def report(phase,status,started,size=None,error=None):
    value={'phase':phase,'status':status,'elapsedSeconds':round(time.monotonic()-started,3),'bytes':size}
    if error is not None:
        name=type(error).__name__
        value['errorClass']=name if name in ('TimeoutExpired','CalledProcessError','CosServiceError','CosClientError',
                                              'RuntimeError','ValueError','OSError','KeyError') else 'OtherError'
        if isinstance(error,subprocess.CalledProcessError):
            value['exit']=error.returncode
        if name=='CosServiceError':
            try:
                code=error.get_error_code(); statusCode=error.get_status_code()
            except Exception:
                code=None; statusCode=None
            knownCodes={'AccessDenied','NoSuchBucket','NoSuchKey','InvalidArgument','SignatureDoesNotMatch',
                        'RequestTimeTooSkewed','InvalidAccessKeyId','EntityTooLarge','PreconditionFailed',
                        'InternalError','ServiceUnavailable','SlowDown'}
            if isinstance(code,str): value['serviceCode']=code if code in knownCodes else 'OtherServiceError'
            if type(statusCode) is int and 100<=statusCode<=599: value['httpStatus']=statusCode
    print(json.dumps(value,separators=(',',':')),flush=True)


@contextmanager
def phase(name,size=None):
    started=time.monotonic(); report(name,'started',started,size)
    try:
        yield
    except Exception as error:
        report(name,'failed',started,size,error)
        raise
    report(name,'completed',started,size)


def identity():
    image=os.environ['CANDIDATE_IMAGE']; sha=os.environ['GITHUB_SHA']
    run=os.environ['GITHUB_RUN_ID']; attempt=os.environ['GITHUB_RUN_ATTEMPT']
    if not re.fullmatch(imagePattern,image) or not re.fullmatch(r'[a-f0-9]{40}',sha):
        raise RuntimeError('candidate identity invalid')
    if not all(re.fullmatch(r'[1-9][0-9]{0,19}',v) for v in (run,attempt)):
        raise RuntimeError('run identity invalid')
    return {'image':image,'sourceSha':sha,'runId':run,'runAttempt':attempt}


def workingDirectory(request):
    base=Path(os.environ['RUNNER_TEMP'])
    if not base.is_absolute() or not base.is_dir() or base.is_symlink(): raise RuntimeError('runner temp invalid')
    return base / ('candidate-oci-'+request['runId']+'-'+request['runAttempt'])


def hashArchive(archive):
    digest=hashlib.sha256()
    with archive.open('rb') as content:
        while block:=content.read(1024*1024): digest.update(block)
    return digest.hexdigest()


def multipartUpload(client,bucket,key,archive,metadata,root):
    """只创建一次上传；异常后保留私有状态，绝不自动中止或重建。"""
    partSize=16*1024*1024
    path=root/'multipart.json'
    original=archive.stat()
    state={'status':'creating','key':key,'sourceSha':metadata['sourceSha'],
           'runId':metadata['runId'],'runAttempt':metadata['runAttempt'],
           'bytes':metadata['bytes'],'sha256':metadata['sha256'],
           'device':original.st_dev,'inode':original.st_ino,'uploadId':None,'parts':{}}
    lock=threading.Lock()

    def persist(initial=False):
        temp=root/'multipart.next'
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
        with os.fdopen(os.open(path if initial else temp,flags,0o600),'w') as output:
            json.dump(state,output,separators=(',',':')); output.flush(); os.fsync(output.fileno())
        if not initial: os.replace(temp,path)
        fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)

    persist(initial=True)
    with phase('cos_multipart_create',metadata['bytes']):
        created=client.create_multipart_upload(Bucket=bucket,Key=key,ACL='private',
                    ForbidOverwrite='true',Metadata={'x-cos-meta-sha256':metadata['sha256']})
        uploadId=created['UploadId']
        if not isinstance(uploadId,str) or not uploadId or len(uploadId)>2048:
            raise RuntimeError('multipart identity invalid')
        state['uploadId']=uploadId; state['status']='uploading'; persist()

    def uploadPart(number):
        offset=(number-1)*partSize; length=min(partSize,metadata['bytes']-offset)
        with archive.open('rb') as source:
            current=os.fstat(source.fileno())
            if (current.st_dev,current.st_ino,current.st_size)!=(original.st_dev,original.st_ino,metadata['bytes']):
                raise RuntimeError('multipart source changed')
            source.seek(offset); content=source.read(length)
        if len(content)!=length: raise RuntimeError('multipart short read')
        digest=hashlib.md5(content).digest()
        result=client.upload_part(Bucket=bucket,Key=key,UploadId=uploadId,PartNumber=number,
                                  Body=content,ContentMD5=base64.b64encode(digest).decode())
        etag=result['ETag']
        if not isinstance(etag,str) or etag.strip('"').lower()!=digest.hex():
            raise RuntimeError('multipart part checksum mismatch')
        with lock:
            state['parts'][str(number)]={'etag':etag,'bytes':length,'md5':digest.hex()}; persist()

    count=(metadata['bytes']+partSize-1)//partSize
    with phase('cos_multipart_parts',metadata['bytes']):
        with ThreadPoolExecutor(max_workers=4) as executor:
            numbers=iter(range(1,count+1))
            pending={executor.submit(uploadPart,n) for n in (next(numbers,None) for _ in range(4)) if n is not None}
            while pending:
                done,pending=wait(pending,return_when=FIRST_COMPLETED)
                for future in done: future.result()
                for _ in done:
                    number=next(numbers,None)
                    if number is not None: pending.add(executor.submit(uploadPart,number))
        if len(state['parts'])!=count or hashArchive(archive)!=metadata['sha256']:
            raise RuntimeError('multipart source or receipts mismatch')
    with phase('cos_multipart_complete',metadata['bytes']):
        state['status']='completing'; persist()
        parts=[{'PartNumber':n,'ETag':state['parts'][str(n)]['etag']} for n in range(1,count+1)]
        client.complete_multipart_upload(Bucket=bucket,Key=key,UploadId=uploadId,
                                         MultipartUpload={'Part':parts},ForbidOverwrite='true')
        state['status']='completed'; persist()


def prepare():
    request=identity(); root=workingDirectory(request)
    root.mkdir(mode=0o700); os.chmod(root,0o700)
    layout=root/'layout'; archive=root/'image.oci'
    with phase('oci_copy'):
        subprocess.run(['skopeo','copy','--all','--preserve-digests','--src-authfile',str(Path.home()/'.docker/config.json'),
                        'docker://'+request['image'],'oci:'+str(layout)+':candidate'],check=True,timeout=1020,
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                       env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'LANG':'C.UTF-8'})
    with phase('oci_archive'):
        index=json.loads((layout/'index.json').read_text())
        if index.get('schemaVersion')!=2 or len(index.get('manifests',[]))!=1:
            raise RuntimeError('OCI index invalid')
        descriptor=index['manifests'][0]
        if descriptor.get('digest')!=request['image'].split('@')[1]:
            raise RuntimeError('OCI root digest mismatch')
        descriptor['annotations']={'io.containerd.image.name':request['image'],
                                   'org.opencontainers.image.ref.name':'@'+request['image'].split('@')[1]}
        (layout/'index.json').write_text(json.dumps(index,separators=(',',':')))
        names=['oci-layout','index.json']
        for entry in sorted((layout/'blobs'/'sha256').iterdir()):
            if not entry.is_file() or entry.is_symlink() or not re.fullmatch(r'[a-f0-9]{64}',entry.name):
                raise RuntimeError('OCI blob path invalid')
            names.append('blobs/sha256/'+entry.name)
        with tarfile.open(archive,'x',format=tarfile.USTAR_FORMAT) as output:
            for name in names:
                source=layout/name; info=tarfile.TarInfo(name); info.size=source.stat().st_size; info.mode=0o600
                with source.open('rb') as content: output.addfile(info,content)
        os.chmod(archive,0o600)
    size=archive.stat().st_size
    with phase('oci_verify',size):
        verifyArchive(archive,request,maximum)
        digest=hashArchive(archive)
        metadata={**request,'bytes':size,'sha256':digest}
        with open(root/'identity.json','x',encoding='utf-8',opener=lambda p,f:os.open(p,f,0o600)) as output:
            json.dump(metadata,output,separators=(',',':')); output.flush(); os.fsync(output.fileno())
    print(json.dumps({'phase':'artifact_identity','bytes':size,'sha256':digest,
                      'sourceSha':request['sourceSha'],'image':request['image']},separators=(',',':')),flush=True)


def upload():
    from qcloud_cos import CosConfig, CosS3Client
    from qcloud_cos.cos_exception import CosServiceError
    logging.disable(logging.CRITICAL)
    request=identity(); root=workingDirectory(request)
    info=root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError('OCI working directory invalid')
    archive=root/'image.oci'; identityPath=root/'identity.json'
    for path in (archive,identityPath):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('OCI working file invalid')
    with phase('oci_recheck'):
        metadata=json.loads(identityPath.read_text())
        if set(metadata)!={*request,'bytes','sha256'} or any(metadata[k]!=v for k,v in request.items()):
            raise RuntimeError('OCI identity mismatch')
        size=archive.stat().st_size
        if type(metadata['bytes']) is not int or size!=metadata['bytes'] or not 0<size<=maximum:
            raise RuntimeError('OCI size mismatch')
        if not isinstance(metadata['sha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',metadata['sha256']) or hashArchive(archive)!=metadata['sha256']:
            raise RuntimeError('OCI hash mismatch')
        verifyArchive(archive,request,maximum)
    bucket=os.environ['CANVAS_COS_BUCKET']; region=os.environ['CANVAS_COS_REGION']
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,61}-[0-9]{6,20}',bucket) or not re.fullmatch(r'ap-[a-z0-9-]+',region):
        raise RuntimeError('COS identity invalid')
    key=f"aivideoReleases/{request['sourceSha']}/{request['runId']}/{request['runAttempt']}/image.oci"
    client=CosS3Client(CosConfig(Region=region,SecretId=os.environ['CANVAS_COS_SECRET_ID'],
                                 SecretKey=os.environ['CANVAS_COS_SECRET_KEY'],Scheme='https',
                                 EnableOldDomain=True,AllowRedirects=False,Timeout=60),retry=0)
    with phase('cos_head',size):
        try:
            remote=client.head_object(Bucket=bucket,Key=key)
        except CosServiceError as error:
            if error.get_status_code()!=404: raise
            remote=None
    if remote is None:
        if size<=16*1024*1024:
            with phase('cos_put',size):
                with archive.open('rb') as content:
                    client.put_object(Bucket=bucket,Key=key,Body=content,ACL='private',ContentLength=str(size),
                                      Metadata={'x-cos-meta-sha256':metadata['sha256']},
                                      ForbidOverwrite='true',EnableMD5=True)
        else:
            multipartUpload(client,bucket,key,archive,metadata,root)
        with phase('cos_readback',size):
            remote=client.head_object(Bucket=bucket,Key=key)
    with phase('cos_verify',size):
        if int(remote['Content-Length'])!=size or remote.get('x-cos-meta-sha256')!=metadata['sha256']:
            raise RuntimeError('COS object identity mismatch')
    with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as output:
        output.write(f"key={key}\nsha256={metadata['sha256']}\nbytes={size}\n")
    # 保留本任务的私有身份与回执供后续 CI 证据步骤；runner 结束时由平台清理。


if __name__=='__main__':
    try:
        os.umask(0o077)
        if len(sys.argv)!=2 or sys.argv[1] not in ('prepare','upload'):
            raise RuntimeError('invalid phase')
        with phase('prepare' if sys.argv[1]=='prepare' else 'upload'):
            (prepare if sys.argv[1]=='prepare' else upload)()
    except Exception:
        raise SystemExit('候选 COS 归档未完成；未输出凭据。')
