// e2e 测试 find-click.ts
//
// 这是 V1 中唯一被真机验证过的反向命令（dev-find 阶段3 已在 ZY22CX8RS5 跑通），
// 本 e2e 把那次手测过程编码成可重跑的测试。
//
// 运行：
//   node --experimental-strip-types --test scripts/__tests__/e2e/find-click.e2e.ts
//
// 行为（pass / fail / skip 判定按 team-lead 阶段4 spec）：
//   - 无 adb 设备 → test.skip (CI-friendly fallback)
//   - broadcast 端到端成功（response.code === 0）→ test pass，无论 addresses 是否空
//   - broadcast 失败 / SDK 完全无响应（empty 回执 / Error: 前缀 / 非 0 exit code）→ test fail
//
// 用户在跑 e2e 前必须保证目标 App 在前台且集成 codelocator-sdk。
// 否则 fetchTouchViewResponse 会抛 "回执为空"，本测试视为 fail（正确反映 broadcast 链路问题）。

// @ts-ignore Node 内置 test runner
import { describe, it, before, type TestContext } from "node:test";
// @ts-ignore Node 内置 assert
import { strict as assert } from "node:assert";

import { runFindClick } from "../../find-click.ts";
import { listDevices } from "../../shared/adb.ts";

interface Skip { reason: string }
type Setup = { skip: Skip } | { skip: null; serial: string };

let setup: Setup = { skip: { reason: "before-hook 未执行" } };

before(async () => {
  // 1) 必须先有连接的设备
  let serials: string[];
  try {
    serials = await listDevices();
  } catch (err) {
    setup = { skip: { reason: `adb devices 失败：${err instanceof Error ? err.message : String(err)}` } };
    return;
  }
  if (serials.length === 0) {
    setup = { skip: { reason: "no adb devices attached" } };
    return;
  }
  setup = { skip: null, serial: serials[0] };
});

describe("find-click e2e (真机)", () => {
  it("broadcast 端到端：response.code === 0 + manifest 结构正确", async (t: TestContext) => {
    if (setup.skip) {
      t.skip(setup.skip.reason);
      return;
    }

    // 注意：broadcast 失败 / SDK 无响应 → 直接 throw → 测试 fail（按 team-lead 阶段4 spec）
    // 这里不再 catch 然后 skip，因为那会掩盖真机链路问题。
    const manifest = await runFindClick({
      serial: setup.serial,
      codeLocatorPath: null, // 自动取最近 grab，缺失也无所谓（addresses 空时不查）
      pretty: false,
    });

    // 必备字段
    assert.equal(manifest.status, "ok", "status 应为 ok");
    assert.equal(manifest.device.serial, setup.serial, "serial 应回填");
    assert.equal(typeof manifest.response.code, "number", "response.code 应为 number");
    assert.equal(manifest.response.code, 0, "BaseResponse.code 应为 0（SDK 解码成功）");
    assert.equal(typeof manifest.response.addressCount, "number");
    assert.ok(Array.isArray(manifest.addresses), "addresses 必须是数组");
    assert.equal(manifest.addresses.length, manifest.response.addressCount, "addressCount 与 addresses.length 一致");

    // addresses 可为空（用户没点屏前），不视为 fail；hints 会提示用户先点屏
    if (manifest.addresses.length === 0) {
      assert.ok(manifest.hints.some((h: string) => h.includes("请在设备上点击")), "空 addresses 应给出点屏提示");
    } else {
      // 有 addresses 时：每条都是非空字符串
      for (const a of manifest.addresses) {
        assert.equal(typeof a, "string");
        assert.ok(a.length > 0);
      }
      // 如果同时还能反查到 grab，进一步校验 resolved 数组长度对得上
      if (manifest.resolved) {
        assert.equal(manifest.resolved.length, manifest.addresses.length);
      }
    }
  });
});
