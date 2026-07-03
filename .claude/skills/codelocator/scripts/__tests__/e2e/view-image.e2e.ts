// scripts/__tests__/e2e/view-image.e2e.ts
// view-image.ts 的真机 e2e：检测 adb 设备，无设备时跳过；需要前台 App 集成 CodeLocator SDK。
// 有效 memAddr 优先来自环境变量 CODELOCATOR_E2E_MEM_ADDR；未提供时尝试先 grab 一帧解析首个 View memAddr。
//
// 跑法：CODELOCATOR_E2E_MEM_ADDR=<memAddr> node --experimental-strip-types --test scripts/__tests__/e2e/view-image.e2e.ts

// @ts-ignore Node 内置，内置模块类型由运行时保证
import { before, describe, test } from "node:test";
// @ts-ignore Node 内置
import assert from "node:assert/strict";
// @ts-ignore Node 内置
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// @ts-ignore Node 内置
import { tmpdir } from "node:os";
// @ts-ignore Node 内置
import { join } from "node:path";

import { runViewImage, ViewImageError } from "../../view-image.ts";
import { runGrab, GrabError } from "../../grab.ts";
import { listDevices, getResumedActivity } from "../../shared/adb.ts";

// node:test 在 strip-types 模式下没有 TS 类型；TestContext 用结构类型代替。
type TestContext = { skip(msg?: string): void };

declare const process: { env: Record<string, string | undefined> };

type JsonObject = Record<string, unknown>;

let hasDevice = false;
let primarySerial: string | null = null;
let probeError: string | null = null;
let resolvedMemAddr: string | null = null;
let setupSkipReason: string | null = null;

function findMemAddr(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as JsonObject;
  for (const key of ["d4", "memAddr", "memoryAddress", "address", "id"]) {
    const v = obj[key];
    if (typeof v === "string" && /^[0-9a-f]+$/iu.test(v)) return v.replace(/^0x/iu, "");
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v.toString(16);
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = findMemAddr(item);
        if (found) return found;
      }
    } else {
      const found = findMemAddr(v);
      if (found) return found;
    }
  }
  return null;
}

async function resolveMemAddrFromGrab(serial: string): Promise<{ memAddr: string | null; skipReason: string | null }> {
  const outDir = mkdtempSync(join(tmpdir(), "codelocator-view-image-e2e-grab-"));
  try {
    const result = await runGrab({
      device: serial,
      packageFilter: null,
      outputDir: outDir,
      skipForegroundCheck: false,
      needColor: false,
      pretty: false,
      help: false,
    });
    const bytes = readFileSync(result.historyFile);
    let offset = 0;
    const tagLen = bytes.readInt32BE(offset); offset += 4 + tagLen;
    const verLen = bytes.readInt32BE(offset); offset += 4 + verLen;
    const appJsonLen = bytes.readInt32BE(offset); offset += 4;
    const appJson = bytes.toString("utf-8", offset, offset + appJsonLen);
    const found = findMemAddr(JSON.parse(appJson));
    return found ? { memAddr: found, skipReason: null } : { memAddr: null, skipReason: "grab 成功但未能从抓帧 JSON 自动解析 memAddr，请设置 CODELOCATOR_E2E_MEM_ADDR" };
  } catch (e) {
    if (e instanceof GrabError && new Set([
      "PROVIDER_UNAVAILABLE", "WRONG_FOREGROUND", "EMPTY_RESPONSE", "NO_PACKAGE", "FOREGROUND_UNKNOWN", "SDK_ERROR", "SDK_EMPTY_DATA",
    ]).has(e.code)) {
      return { memAddr: null, skipReason: `前台 App 不满足抓取条件（${e.code}），请打开集成 CodeLocator SDK 的 App 或设置 CODELOCATOR_E2E_MEM_ADDR` };
    }
    return { memAddr: null, skipReason: e instanceof Error ? e.message : String(e) };
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe("view-image e2e (需要真机 + CodeLocator SDK)", () => {
  before(async () => {
    try {
      const serials = await listDevices();
      hasDevice = serials.length > 0;
      primarySerial = hasDevice ? serials[0] : null;
      if (!hasDevice || !primarySerial) return;

      const resumed = await getResumedActivity({ serial: primarySerial });
      if (!resumed) {
        setupSkipReason = `设备 ${primarySerial} 无前台 Activity（可能锁屏 / 黑屏）`;
        return;
      }

      const envMem = process.env.CODELOCATOR_E2E_MEM_ADDR;
      if (envMem && /^[0-9a-f]+$/iu.test(envMem.replace(/^0x/iu, ""))) {
        resolvedMemAddr = envMem.replace(/^0x/iu, "");
        return;
      }

      const resolved = await resolveMemAddrFromGrab(primarySerial);
      resolvedMemAddr = resolved.memAddr;
      setupSkipReason = resolved.skipReason;
    } catch (err) {
      hasDevice = false;
      probeError = err instanceof Error ? err.message : String(err);
    }
  });

  test("基本 screenshot 类型：有效 memAddr 应 pull 出本地 PNG", async (t: TestContext) => {
    if (!hasDevice || !primarySerial) {
      t.skip(probeError ? `no adb device: ${probeError}` : "no adb device connected");
      return;
    }
    if (!resolvedMemAddr) {
      t.skip(setupSkipReason ?? "未提供有效 memAddr；可设置 CODELOCATOR_E2E_MEM_ADDR 后重跑");
      return;
    }

    const outDir = mkdtempSync(join(tmpdir(), "codelocator-view-image-e2e-"));
    const output = join(outDir, `view-${resolvedMemAddr}.png`);
    try {
      const result = await runViewImage({ memAddr: resolvedMemAddr, type: "screenshot", device: primarySerial, output });
      assert.equal(result.status, "ok");
      assert.equal(result.device, primarySerial);
      assert.equal(result.type, "screenshot");
      assert.equal(result.output, output);
      assert.ok(existsSync(output), `输出文件应存在: ${output}`);
      const bytes = readFileSync(output);
      assert.ok(bytes.length > 0, "输出 PNG 不应为空");
      assert.equal(bytes[0], 0x89, "PNG magic 第 1 字节");
      assert.equal(bytes.toString("ascii", 1, 4), "PNG", "PNG magic");
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test("无效 memAddr：应返回 SDK 错误或 pull 不到图片", async (t: TestContext) => {
    if (!hasDevice || !primarySerial) {
      t.skip(probeError ? `no adb device: ${probeError}` : "no adb device connected");
      return;
    }
    const outDir = mkdtempSync(join(tmpdir(), "codelocator-view-image-e2e-invalid-"));
    const output = join(outDir, "invalid.png");
    try {
      await assert.rejects(
        () => runViewImage({ memAddr: "1", type: "screenshot", device: primarySerial, output }),
        (e: unknown) => {
          if (e instanceof ViewImageError) {
            assert.ok(["SDK_ERROR", "PULL_IMAGE_FAILED", "BROADCAST_FAILED"].includes(e.code), `非预期错误码: ${e.code}`);
            return true;
          }
          return false;
        },
      );
      if (existsSync(output)) {
        const bytes = readFileSync(output);
        assert.equal(bytes.length, 0, "无效 memAddr 即使生成文件，也应为空图片文件");
      }
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
