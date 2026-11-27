import { expect, test } from "bun:test";
import { mkdtemp, rm } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiTenant } from "./index";

test("named superadmins use separate control sessions and keep their creative accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "toonflowNamedAdmin"));
  const previous = process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS;
  try {
    delete process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS;
    const auth = createMultiTenant(directory);
    const password = "valid-fixture-password";
    await auth.setup("root", password);
    const first = await auth.createUser("first", password);
    const second = await auth.createUser("second", password);
    const third = await auth.createUser("third", password);
    const outside = await auth.createUser("outside", password);

    await expect(auth.login(first.userName, password)).rejects.toMatchObject({ status: 401 });
    process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS = ` ${first.id},${second.id}, ${third.id} , outside`;
    await expect(auth.login(outside.userName, password)).rejects.toMatchObject({ status: 401 });
    await expect(auth.loginNamedAdmin(outside.userName, password)).rejects.toMatchObject({ status: 401 });
    await expect(auth.loginNamedAdmin("root", password)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login(first.userName, "incorrect-password")).rejects.toMatchObject({ status: 401 });

    const creative = await auth.loginWeb(first.userName, password);
    const rootCreative = await auth.loginWeb("root", password);
    expect(creative.user).toEqual({ id: first.id, userName: first.userName, role: "user" });
    await expect(auth.authorize(creative.token)).rejects.toMatchObject({ status: 401 });
    await expect(auth.authorize(rootCreative.token)).rejects.toMatchObject({ status: 401 });

    const rootControl = await auth.login("root", password);
    const firstControl = await auth.login(first.userName, password);
    const secondControl = await auth.login(second.userName, password);
    const thirdControl = await auth.loginNamedAdmin(third.userName, password);
    expect(await auth.authorize(rootControl)).toEqual({ id: "admin", userName: "root", role: "admin" });
    expect(await auth.authorize(firstControl)).toEqual({ id: first.id, userName: first.userName, role: "admin" });
    expect(await auth.authorize(secondControl)).toEqual({ id: second.id, userName: second.userName, role: "admin" });
    expect(await auth.authorize(thirdControl)).toEqual({ id: third.id, userName: third.userName, role: "admin" });
    expect(await auth.authorizeNamedAdmin(thirdControl)).toMatchObject({ id: third.id, role: "admin" });
    await expect(auth.authorizeNamedAdmin(rootControl)).rejects.toMatchObject({ status: 401 });
    expect(await auth.authenticateWeb(firstControl)).toBeNull();
    expect(await auth.authenticateWeb(creative.token)).toEqual(creative.user);

    const reloaded = createMultiTenant(directory);
    await expect(reloaded.authorize(firstControl)).rejects.toMatchObject({ status: 401 });
    const reloadedControl = await reloaded.login(first.userName, password);
    expect(await reloaded.authorize(reloadedControl)).toMatchObject({ id: first.id, role: "admin" });

    await auth.logout(firstControl);
    await expect(auth.authorize(firstControl)).rejects.toMatchObject({ status: 401 });
    expect(await auth.authorize(rootControl)).toMatchObject({ id: "admin", role: "admin" });
    expect(await auth.authorize(secondControl)).toMatchObject({ id: second.id, role: "admin" });
    await auth.setUserDisabled(second.id, true);
    await expect(auth.authorize(secondControl)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login(second.userName, password)).rejects.toMatchObject({ status: 403 });
    await auth.setUserDisabled(second.id, false);
    await expect(auth.authorize(secondControl)).rejects.toMatchObject({ status: 401 });
    const freshSecondControl = await auth.login(second.userName, password);
    await auth.resetUserPassword(second.id, "new-fixture-password");
    await expect(auth.authorize(freshSecondControl)).rejects.toMatchObject({ status: 401 });
    const resetSecondControl = await auth.login(second.userName, "new-fixture-password");
    expect(await auth.authorize(resetSecondControl)).toMatchObject({ id: second.id, role: "admin" });

    process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS = `${first.id},${second.id}`;
    await expect(auth.authorize(thirdControl)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login(third.userName, password)).rejects.toMatchObject({ status: 401 });
    expect((await auth.loginWeb(third.userName, password)).user).toMatchObject({ id: third.id, role: "user" });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(auth.loginNamedAdmin(first.userName, "incorrect-password")).rejects.toMatchObject({ status: 401 });
    }
    await expect(auth.loginNamedAdmin(first.userName, password)).rejects.toMatchObject({ status: 429 });
    await expect(auth.loginWeb(first.userName, password)).rejects.toMatchObject({ status: 429 });
  } finally {
    if (previous === undefined) delete process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS;
    else process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
