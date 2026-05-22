// provider.test.ts
// 覆盖：probeProvider 三态（available / not available / error）+ pollAsyncResult
//
// probeProvider 调底层 shell()，对接 content query 输出；用 fake-adb 灌入不同 stdout 验证解析。

// @ts-ignore Node 内置
import { test } from "node:test";
// @ts-ignore Node 内置
import { strict as assert } from "node:assert";

import { probeProvider, pollAsyncResult } from "../../shared/provider.ts";
import { makeFakeAdb } from "../helpers/fake-adb.ts";

test("probeProvider: 可用 → 解析 version / asyncBroadcast / asyncResult", async () => {
  const adb = makeFakeAdb([
    {
      match: "shell content query",
      stdout: "Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=false, AsyncResult=",
    },
  ]);
  try {
    const h = await probeProvider("com.foo.bar", { adbPath: adb.path });
    assert.equal(h.available, true);
    assert.equal(h.version, "2.1.0");
    assert.equal(h.asyncBroadcast, false);
    assert.equal(h.asyncResult, "");
    assert.ok(h.raw.includes("Row: 0"));
  } finally {
    adb.cleanup();
  }
});

test("probeProvider: AsyncBroadcast=true + AsyncResult=FP:...", async () => {
  const adb = makeFakeAdb([
    {
      match: "shell content query",
      stdout: "Row: 0 CodeLocatorVersion=2.0.7, AsyncBroadcast=true, AsyncResult=FP:/sdcard/x.txt",
    },
  ]);
  try {
    const h = await probeProvider("com.foo.bar", { adbPath: adb.path });
    assert.equal(h.asyncBroadcast, true);
    assert.equal(h.asyncResult, "FP:/sdcard/x.txt");
  } finally {
    adb.cleanup();
  }
});

test("probeProvider: 不可用（stdout 无 Row:） → available=false", async () => {
  // 这是 ContentProvider 不存在 / App 未集成 SDK 的典型场景
  const adb = makeFakeAdb([
    {
      match: "shell content query",
      stdout: "",
      stderr: "Error while accessing provider:com.foo.bar.CodeLocatorProvider",
      exitCode: 0, // adb content query 通常 exitCode=0 但 stderr 含 error
    },
  ]);
  try {
    const h = await probeProvider("com.foo.bar", { adbPath: adb.path });
    assert.equal(h.available, false);
    assert.equal(h.version, null);
    assert.equal(h.asyncBroadcast, false);
    assert.equal(h.asyncResult, "");
  } finally {
    adb.cleanup();
  }
});

test("probeProvider: 收窄后的判定 — stdout 含 'error' 字样但同时含 Row: → 仍视为可用", async () => {
  // B3 修复的回归：之前用 lower.includes("error") 会误伤这种"调试串里出现 error"的输出
  const adb = makeFakeAdb([
    {
      match: "shell content query",
      stdout:
        "Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=false, AsyncResult=Error_in_payload_but_still_a_row",
    },
  ]);
  try {
    const h = await probeProvider("com.foo.bar", { adbPath: adb.path });
    assert.equal(h.available, true, "Row: 在场即视为可用，不被宽 error 子串误伤");
  } finally {
    adb.cleanup();
  }
});

test("pollAsyncResult: 第一次轮询命中 FP: → 立即返回 path", async () => {
  const adb = makeFakeAdb([
    {
      match: "shell content query",
      stdout: "Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=true, AsyncResult=FP:/sdcard/poll.txt",
    },
  ]);
  try {
    const p = await pollAsyncResult("com.foo.bar", 3, { adbPath: adb.path });
    assert.equal(p, "/sdcard/poll.txt");
  } finally {
    adb.cleanup();
  }
});

test("pollAsyncResult: Provider 不可用 → 立即返回 null（不死循环）", async () => {
  const adb = makeFakeAdb([
    { match: "shell content query", stdout: "", stderr: "Error", exitCode: 0 },
  ]);
  try {
    const p = await pollAsyncResult("com.foo.bar", 3, { adbPath: adb.path });
    assert.equal(p, null);
  } finally {
    adb.cleanup();
  }
});
