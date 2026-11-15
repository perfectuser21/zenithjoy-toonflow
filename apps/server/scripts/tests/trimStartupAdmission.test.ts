import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateStartupAdmission, waitForStartupAdmission } from '../trimStartupAdmission.ts';

const expected = { bootId: '00000000-0000-4000-8000-000000000001', workerPid: 123, workerStart: '456' };
const proof = { ...expected, nonce: '00000000-0000-4000-8000-000000000002' };
test('请求处理必须等事前证明完成', async () => {
  let resolve!: (value: typeof proof) => void;
  const deferred = new Promise<typeof proof>(r => { resolve = r; });
  let served = false;
  const task = waitForStartupAdmission(() => deferred, expected).then(() => { served = true; });
  await Promise.resolve();
  assert.equal(served, false);
  resolve(proof);
  await task;
  assert.equal(served, true);
});
test('旧进程、重启和错误 nonce 的证明不可复用', () => {
  assert.equal(validateStartupAdmission(proof, expected), proof.nonce);
  assert.throws(() => validateStartupAdmission({ ...proof, workerPid: 124 }, expected));
  assert.throws(() => validateStartupAdmission({ ...proof, workerStart: '455' }, expected));
  assert.throws(() => validateStartupAdmission({ ...proof, bootId: '00000000-0000-4000-8000-000000000003' }, expected));
  assert.throws(() => validateStartupAdmission({ ...proof, nonce: 'bad' }, expected));
  assert.throws(() => validateStartupAdmission({ ...proof, extra: true }, expected));
});
