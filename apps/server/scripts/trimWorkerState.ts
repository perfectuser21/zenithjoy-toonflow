import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 只有文件内容和目录项均同步后，才能视作开始下一项外部操作的持久屏障。 */
export async function writeDurableState(path: string, state: Record<string, unknown>) {
  const parentPath = dirname(path);
  const temporary = join(parentPath, `.trim-state-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
