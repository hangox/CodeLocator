// grab.e2e.ts
// 真机端到端：连一台 adb 设备时，跑完整 grab 流程并断言落盘文件可被读出 "CodeLocator" magic。
// 无设备时 t.skip()，不让 CI 失败。
//
// 文件名以 .ts 结尾即可被 node --test 自动收（如果用 glob __tests__/e2e/**/*.test.ts 则收不到，
// 所以跑 e2e 时改用：node --test --experimental-strip-types __tests__/e2e/grab.e2e.ts）。

// @ts-ignore Node 内置
import { test } from "node:test";
// @ts-ignore Node 内置
import { strict as assert } from "node:assert";
// @ts-ignore Node 内置
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
// @ts-ignore Node 内置
import { tmpdir } from "node:os";
// @ts-ignore Node 内置
import { join } from "node:path";

import { listDevices, getResumedActivity } from "../../shared/adb.ts";
import { runGrab, GrabError } from "../../grab.ts";

const TAG_HEADER = "CodeLocator";

test("grab e2e: 真机抓取 → 文件落盘 → magic 校验", async (t: { skip(msg?: string): void }) => {
  // 1) 检测设备
  let devices: string[];
  try {
    devices = await listDevices();
  } catch (e) {
    t.skip(`adb 调用失败，跳过 e2e: ${(e as Error).message}`);
    return;
  }
  if (devices.length === 0) {
    t.skip("无连接的 adb 设备，跳过 e2e");
    return;
  }

  const serial = devices[0];

  // 2) 检测前台 App 是否集成 SDK 是更深的判定，这里只做"前台有 App"的轻量检查；
  //    更严格的 SDK 集成判断由 runGrab 内部的 probeProvider 兜底，失败会抛 PROVIDER_UNAVAILABLE。
  const resumed = await getResumedActivity({ serial });
  if (!resumed) {
    t.skip(`设备 ${serial} 无前台 Activity（可能锁屏 / 黑屏），跳过 e2e`);
    return;
  }

  // 3) 用临时目录跑，避免污染用户的 ~/.codeLocator_main/historyFile/
  const outDir = mkdtempSync(join(tmpdir(), "codelocator-e2e-"));
  let createdFile: string | null = null;
  try {
    let result;
    try {
      result = await runGrab({
        device: serial,
        packageFilter: null,
        outputDir: outDir,
        skipForegroundCheck: false,
        needColor: false,
        pretty: false,
        help: false,
      });
    } catch (e) {
      // 常见非致命跳过：前台 App 没集成 SDK / Provider 不可用 / 前台错 App。
      // 用 GrabError.code 判断更稳：错误 message 是给人看的中文，code 才是稳定标识符。
      if (e instanceof GrabError && new Set([
        "PROVIDER_UNAVAILABLE", "WRONG_FOREGROUND", "EMPTY_RESPONSE", "NO_PACKAGE", "FOREGROUND_UNKNOWN",
      ]).has(e.code)) {
        t.skip(`前台 App 不满足抓取条件（${e.code}），跳过 e2e: ${e.message}`);
        return;
      }
      throw e;
    }

    createdFile = result.historyFile;

    // 4) 断言：文件存在、size > 0、含 CodeLocator magic
    assert.ok(existsSync(result.historyFile), `historyFile 应存在: ${result.historyFile}`);
    assert.ok(result.sizeBytes > 0, "sizeBytes > 0");

    const bytes = readFileSync(result.historyFile);
    // 文件头：4 字节 BE 长度 + tag bytes
    const tagLen = bytes.readInt32BE(0);
    assert.equal(tagLen, TAG_HEADER.length, "tag 长度字段应为 11");
    const tag = bytes.toString("utf-8", 4, 4 + tagLen);
    assert.equal(tag, TAG_HEADER, "magic = CodeLocator");

    // 5) 关键字段非空
    assert.ok(result.package.length > 0, "package 非空");
    assert.ok(result.apiLevel > 0, "apiLevel > 0");
    assert.ok(["inline", "file"].includes(result.payloadSource), `payloadSource: ${result.payloadSource}`);
  } finally {
    // 清理：删测试产生的文件 + 临时目录
    if (createdFile && existsSync(createdFile)) {
      try { rmSync(createdFile, { force: true }); } catch { /* ignore */ }
    }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
