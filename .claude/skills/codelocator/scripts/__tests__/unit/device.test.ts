// device.test.ts
// 覆盖：pickDevice 四态 + DeviceSelectError + AdbRunOptions 透传
//
// 同样用 fake-adb 喂数据，比 mock 内部模块稳。

// @ts-ignore Node 内置
import { test } from "node:test";
// @ts-ignore Node 内置
import { strict as assert } from "node:assert";

import { pickDevice, DeviceSelectError } from "../../shared/device.ts";
import { makeFakeAdb } from "../helpers/fake-adb.ts";

test("pickDevice: 0 设备 → NO_DEVICE", async () => {
  const adb = makeFakeAdb([{ match: "devices", stdout: "List of devices attached\n" }]);
  try {
    await assert.rejects(
      () => pickDevice(null, { adbPath: adb.path }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceSelectError);
        assert.equal((err as DeviceSelectError).code, "NO_DEVICE");
        assert.deepEqual((err as DeviceSelectError).candidates, []);
        return true;
      },
    );
  } finally {
    adb.cleanup();
  }
});

test("pickDevice: 1 设备 → 自动选", async () => {
  const adb = makeFakeAdb([
    { match: "devices", stdout: "List of devices attached\nLONELY\tdevice\n" },
  ]);
  try {
    const serial = await pickDevice(null, { adbPath: adb.path });
    assert.equal(serial, "LONELY");
  } finally {
    adb.cleanup();
  }
});

test("pickDevice: 多设备 + 无显式 → MULTIPLE_DEVICES，candidates 含全部 serial", async () => {
  const adb = makeFakeAdb([
    { match: "devices", stdout: "List of devices attached\nA\tdevice\nB\tdevice\nC\tdevice\n" },
  ]);
  try {
    await assert.rejects(
      () => pickDevice(null, { adbPath: adb.path }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceSelectError);
        assert.equal((err as DeviceSelectError).code, "MULTIPLE_DEVICES");
        assert.deepEqual((err as DeviceSelectError).candidates, ["A", "B", "C"]);
        return true;
      },
    );
  } finally {
    adb.cleanup();
  }
});

test("pickDevice: 显式 serial 命中 → 直接返回", async () => {
  const adb = makeFakeAdb([
    { match: "devices", stdout: "List of devices attached\nA\tdevice\nB\tdevice\n" },
  ]);
  try {
    const serial = await pickDevice("B", { adbPath: adb.path });
    assert.equal(serial, "B");
  } finally {
    adb.cleanup();
  }
});

test("pickDevice: 显式 serial 不在线 → NO_DEVICE + 列出实际在线", async () => {
  const adb = makeFakeAdb([
    { match: "devices", stdout: "List of devices attached\nREAL\tdevice\n" },
  ]);
  try {
    await assert.rejects(
      () => pickDevice("GHOST", { adbPath: adb.path }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceSelectError);
        assert.equal((err as DeviceSelectError).code, "NO_DEVICE");
        assert.deepEqual((err as DeviceSelectError).candidates, ["REAL"]);
        return true;
      },
    );
  } finally {
    adb.cleanup();
  }
});

test("AdbRunOptions 透传：adbPath 真的被 pickDevice 转发给 listDevices", async () => {
  // 用一个故意"无效"的 adb path（不存在），如果 pickDevice 不透传就会去打默认 adb。
  // 显式 adbPath="/nonexistent" → spawn ENOENT → reject。
  await assert.rejects(
    () => pickDevice(null, { adbPath: "/__definitely_not_existing_adb__" }),
    (err: unknown) => {
      // 这里抛的是普通 Error（spawn 失败），不是 DeviceSelectError。这正好证明走的是 listDevices 路径。
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /ENOENT|adb devices failed/u);
      return true;
    },
  );
});
