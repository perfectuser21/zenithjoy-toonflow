import { expect, test } from "bun:test";
import { createTrimReadQueue } from "./trimReadQueue";

test("simultaneous clip previews wait for the active read and all complete", async () => {
  const queue = createTrimReadQueue(8);
  const signal = new AbortController().signal;
  const firstRead = Promise.withResolvers<void>();
  const started: number[] = [];

  const requests = Array.from({ length: 8 }, (_, index) => queue.run(signal, async () => {
    started.push(index);
    if (index === 0) await firstRead.promise;
    return index;
  }));

  await Promise.resolve();
  expect(started).toEqual([0]);
  firstRead.resolve();
  expect(await Promise.all(requests)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(queue.busy).toBe(false);
});

test("a disconnected preview frees its place and does not read a clip", async () => {
  const queue = createTrimReadQueue(1);
  const gate = Promise.withResolvers<void>();
  const active = queue.run(new AbortController().signal, () => gate.promise);
  const disconnected = new AbortController();
  const waiting = queue.run(disconnected.signal, () => {
    throw new Error("disconnected request executed");
  });
  await expect(queue.run(new AbortController().signal, () => false)).rejects.toMatchObject({ status: 429 });

  disconnected.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  const next = queue.run(new AbortController().signal, () => "clip");
  gate.resolve();
  await active;
  expect(await next).toBe("clip");
});
