// scripts/__tests__/e2e/schema.e2e.ts
// schema.ts 的真机 e2e。检测当前 adb 连接：
//   - 没有设备 → 整组跳过（不阻塞 CI / 离线开发）
//   - 有设备  → 跑两条用例：主路径成功 + fallback 触发
//
// 跑法：node --experimental-strip-types --test scripts/__tests__/e2e/schema.e2e.ts
//
// 注意：不要在这里跑会改变 App 状态的 schema；用 https://example.com 这种系统级 URL
// 以及一个一定不存在的 cl-* schema，App 端在最坏情况下也只是 broadcast 静默忽略。

// @ts-ignore Node 内置，内置模块类型由运行时保证
import { before, describe, test } from "node:test";
// @ts-ignore Node 内置
import assert from "node:assert/strict";

// node:test 在 strip-types 模式下没有 TS 类型；TestContext 用 any 代替。
type TestContext = { skip(msg?: string): void };

import { runSchema } from "../../schema.ts";
import { listDevices } from "../../shared/adb.ts";

let hasDevice = false;
let primarySerial: string | null = null;
let probeError: string | null = null;

describe("schema e2e (需要真机)", () => {
  before(async () => {
    try {
      const serials = await listDevices();
      hasDevice = serials.length > 0;
      primarySerial = hasDevice ? serials[0] : null;
    } catch (err) {
      hasDevice = false;
      probeError = err instanceof Error ? err.message : String(err);
    }
  });

  test("主路径：https://example.com 系统浏览器路由应成功", async (t: TestContext) => {
    if (!hasDevice) {
      t.skip(probeError ? `no adb device: ${probeError}` : "no adb device connected");
      return;
    }
    const result = await runSchema({ url: "https://example.com", device: primarySerial });
    assert.equal(
      result.primary.ok,
      true,
      `期望 am start 成功；实际 stdout=${JSON.stringify(result.primary.stdout)} stderr=${JSON.stringify(result.primary.stderr)}`,
    );
    assert.equal(result.fallback, undefined, "成功的主路径不应触发 fallback");
  });

  test("fallback：cl-nonexistent-scheme 应触发 broadcast 兜底", async (t: TestContext) => {
    if (!hasDevice) {
      t.skip(probeError ? `no adb device: ${probeError}` : "no adb device connected");
      return;
    }
    const result = await runSchema({
      url: "cl-nonexistent-scheme-12345://test?from=e2e",
      device: primarySerial,
    });
    assert.equal(result.primary.ok, false, "保留 schema 应让系统 am start 路由失败");
    assert.ok(result.fallback, "fallback 应被触发");
    // broadcast 本身只要被 am 接收即视为 ok（不论设备端 SDK 是否处理）。
    assert.equal(result.fallback!.ok, true, "broadcast 自身应成功投递");
    // payload 三态都接受：device 端没装 CodeLocator SDK 时为 empty，装了则可能 inline/file。
    const kind = result.fallback!.payload.kind;
    assert.ok(
      ["empty", "file", "inline", "error"].includes(kind),
      `非预期 payload kind=${kind}`,
    );
  });
});
