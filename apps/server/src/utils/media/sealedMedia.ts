import { dlopen, FFIType, ptr } from "bun:ffi";

// 只对已经完成身份、大小和摘要校验的媒体使用；生命周期由调用方的回调限定。
export async function withSealedMedia<T>(bytes: Buffer, action: (path: string) => Promise<T>) {
  if (process.platform !== "linux" || !bytes.length || bytes.length > 128 * 1024 * 1024) throw Object.assign(new Error("安全媒体暂不可用"), { status: 503 });
  const libc = dlopen("libc.so.6", {
    memfd_create: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.int },
    write: { args: [FFIType.int, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
    close: { args: [FFIType.int], returns: FFIType.int },
  });
  let fd = -1;
  try {
    fd = libc.symbols.memfd_create(ptr(Buffer.from("toonflow-trim\0")), 3); // CLOEXEC + ALLOW_SEALING
    if (fd < 0) throw new Error("memfd unavailable");
    let offset = 0;
    while (offset < bytes.length) {
      const written = Number(libc.symbols.write(fd, ptr(bytes, offset), bytes.length - offset));
      if (!Number.isSafeInteger(written) || written <= 0) throw new Error("memfd write failed");
      offset += written;
    }
    // F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE
    if (libc.symbols.fcntl(fd, 1033, 15) !== 0) throw new Error("memfd seal failed");
    const seals = libc.symbols.fcntl(fd, 1034, 0);
    if (seals < 0 || (seals & 15) !== 15) throw new Error("memfd seal failed");
    return await action(`/proc/${process.pid}/fd/${fd}`);
  } finally {
    if (fd >= 0) libc.symbols.close(fd);
    libc.close();
  }
}
