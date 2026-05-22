// adb.test.ts
// 覆盖 shared/adb.ts。
// 策略：用 helpers/fake-adb.ts 在 tmpdir 写一份 Node 脚本，通过 AdbRunOptions.adbPath 喂给被测函数。
// 不 stub child_process — 真实 spawn 一个 fake adb 比 mock 内部模块更稳，且能顺便验证 -s <serial> 等参数拼装。

// @ts-ignore Node 内置
import { test } from "node:test";
// @ts-ignore Node 内置
import { strict as assert } from "node:assert";

import {
  listDevices,
  shell,
  broadcast,
  pull,
  getApiLevel,
  getResumedActivity,
} from "../../shared/adb.ts";
import { makeFakeAdb } from "../helpers/fake-adb.ts";

test("listDevices: 解析 adb devices stdout（含未授权设备 / 离线设备）", async () => {
  const adb = makeFakeAdb([
    {
      match: "devices",
      stdout: "List of devices attached\nABC123\tdevice\nDEF456\tunauthorized\nGHI789\toffline\nXYZ\tdevice\n",
    },
  ]);
  try {
    const serials = await listDevices({ adbPath: adb.path });
    // 只接受 state=device 的，过滤掉 unauthorized / offline
    assert.deepEqual(serials, ["ABC123", "XYZ"]);
    const invocations = adb.readInvocations();
    assert.deepEqual(invocations, [["devices"]]);
  } finally {
    adb.cleanup();
  }
});

test("listDevices: 命令失败抛错", async () => {
  const adb = makeFakeAdb([
    { match: "devices", stderr: "adb: error: foo", exitCode: 1 },
  ]);
  try {
    await assert.rejects(
      () => listDevices({ adbPath: adb.path }),
      /adb devices failed/u,
    );
  } finally {
    adb.cleanup();
  }
});

test("shell: 传 serial → 拼上 -s <serial>", async () => {
  const adb = makeFakeAdb([
    { match: "-s mySerial shell echo hi", stdout: "hi\n" },
  ]);
  try {
    const r = await shell("echo hi", { serial: "mySerial", adbPath: adb.path });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "hi");
    const inv = adb.readInvocations();
    assert.deepEqual(inv, [["-s", "mySerial", "shell", "echo hi"]]);
  } finally {
    adb.cleanup();
  }
});

test("shell: 不传 serial → 不带 -s", async () => {
  const adb = makeFakeAdb([
    { match: "shell echo hi", stdout: "hi" },
  ]);
  try {
    await shell("echo hi", { adbPath: adb.path });
    const inv = adb.readInvocations();
    assert.deepEqual(inv, [["shell", "echo hi"]]);
  } finally {
    adb.cleanup();
  }
});

test("broadcast: 拼接 am broadcast -a <action> --es codeLocator_shell_args '<base64>'", async () => {
  const adb = makeFakeAdb([
    { match: "shell am broadcast", stdout: 'Broadcast completed: result=-1, data="FP:/sdcard/x"' },
  ]);
  try {
    const r = await broadcast("foo.ACTION", "ABCDE", { adbPath: adb.path });
    assert.equal(r.code, 0);
    assert.equal(r.raw, r.stdout); // raw 与 stdout 同源
    const inv = adb.readInvocations();
    // shell 的 cmd 整段塞进单个 argv
    assert.equal(inv.length, 1);
    assert.equal(inv[0][0], "shell");
    assert.match(inv[0][1], /^am broadcast -a foo\.ACTION --es codeLocator_shell_args '/u);
    assert.ok(inv[0][1].includes("'ABCDE'"));
  } finally {
    adb.cleanup();
  }
});

test("broadcast: encodedArgs=null 时不拼 --es", async () => {
  const adb = makeFakeAdb([
    { match: "shell am broadcast -a no.args", stdout: "" },
  ]);
  try {
    await broadcast("no.args", null, { adbPath: adb.path });
    const inv = adb.readInvocations();
    assert.equal(inv[0][1], "am broadcast -a no.args");
  } finally {
    adb.cleanup();
  }
});

test("pull: 传 serial 时拼 -s，参数顺序为 [-s, serial, pull, remote, local]", async () => {
  const adb = makeFakeAdb([
    { match: "-s S1 pull /sdcard/a /tmp/a", stdout: "" },
  ]);
  try {
    const r = await pull("/sdcard/a", "/tmp/a", { serial: "S1", adbPath: adb.path });
    assert.equal(r.code, 0);
    const inv = adb.readInvocations();
    assert.deepEqual(inv, [["-s", "S1", "pull", "/sdcard/a", "/tmp/a"]]);
  } finally {
    adb.cleanup();
  }
});

test("getApiLevel: 解析 ro.build.version.sdk 数字", async () => {
  const adb = makeFakeAdb([
    { match: "shell getprop ro.build.version.sdk", stdout: "33\n" },
  ]);
  try {
    const level = await getApiLevel({ adbPath: adb.path });
    assert.equal(level, 33);
  } finally {
    adb.cleanup();
  }
});

test("getApiLevel: 非数字 stdout 抛错", async () => {
  const adb = makeFakeAdb([
    { match: "shell getprop", stdout: "weird\n" },
  ]);
  try {
    await assert.rejects(() => getApiLevel({ adbPath: adb.path }), /unexpected ro\.build\.version\.sdk/u);
  } finally {
    adb.cleanup();
  }
});

test("getResumedActivity: Android ≤12 形态 mResumedActivity:", async () => {
  const adb = makeFakeAdb([
    {
      match: "shell dumpsys",
      stdout: "    mResumedActivity: ActivityRecord{abc u0 com.foo.bar/.MainActivity t99}",
    },
  ]);
  try {
    const r = await getResumedActivity({ adbPath: adb.path });
    assert.equal(r, "com.foo.bar/.MainActivity");
  } finally {
    adb.cleanup();
  }
});

test("getResumedActivity: Android 13+ 形态 topResumedActivity=", async () => {
  // Android 13+ 的 dumpsys 改成等号形态 + 不同字段名
  const adb = makeFakeAdb([
    {
      match: "shell dumpsys",
      stdout: "    topResumedActivity=ActivityRecord{246661124 u0 com.foo.bar/.MainActivity t600}",
    },
  ]);
  try {
    const r = await getResumedActivity({ adbPath: adb.path });
    assert.equal(r, "com.foo.bar/.MainActivity", "新机型也应能解析出 pkg/.Activity");
  } finally {
    adb.cleanup();
  }
});

test("getResumedActivity: 解析失败 → null（不抛错）", async () => {
  const adb = makeFakeAdb([
    { match: "shell dumpsys", stdout: "(no resumed activity)" },
  ]);
  try {
    const r = await getResumedActivity({ adbPath: adb.path });
    assert.equal(r, null);
  } finally {
    adb.cleanup();
  }
});

test("ADB_PATH env：未传 adbPath 时回退到 ADB_PATH 环境变量", async () => {
  const adb = makeFakeAdb([
    { match: "devices", stdout: "List of devices attached\nENV1\tdevice\n" },
  ]);
  const previous = process.env.ADB_PATH;
  process.env.ADB_PATH = adb.path;
  try {
    const serials = await listDevices(); // 不传 adbPath
    assert.deepEqual(serials, ["ENV1"]);
  } finally {
    if (previous === undefined) delete process.env.ADB_PATH;
    else process.env.ADB_PATH = previous;
    adb.cleanup();
  }
});

declare const process: { env: Record<string, string | undefined> };
