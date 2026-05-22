// scripts/__tests__/unit/schema.test.ts
// schema.ts 的单元测试。零真机依赖：通过临时生成的 fake-adb.mjs + ADB_PATH 环境变量
// 替换底层 adb 二进制，覆盖 am start / am broadcast / adb devices 三类调用。
//
// 跑法：node --experimental-strip-types --test scripts/__tests__/unit/schema.test.ts

// @ts-ignore Node 内置，内置模块类型由运行时保证
import { afterEach, beforeEach, describe, test } from "node:test";
// @ts-ignore Node 内置
import assert from "node:assert/strict";
// @ts-ignore Node 内置
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore Node 内置
import { tmpdir } from "node:os";
// @ts-ignore Node 内置
import { join } from "node:path";

import { runSchema, runSchemaCli } from "../../schema.ts";
import { decodeShellArgs } from "../../shared/codec.ts";

declare const process: { env: Record<string, string | undefined> };
declare const console: { log(...args: unknown[]): void };

// ---- fake adb 生成器 ----
// 为什么内嵌字符串而不是单独 fixture：保持本测试单文件自包含，不污染团队其它 dev 的目录。
// 行为通过 env 切换：
//   FAKE_DEVICES     逗号分隔 serial 列表（默认 "emu1"）
//   FAKE_AM_START    success | fail_text | fail_code（默认 success）
//   FAKE_BROADCAST   fp | inline | empty | error（默认 fp）
//   FAKE_ADB_LOG     每次调用追加一行 JSON(argv)，供断言用
const FAKE_ADB_SRC = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_ADB_LOG;
if (log) appendFileSync(log, JSON.stringify(argv) + "\\n");

let rest = argv;
if (argv[0] === "-s") rest = argv.slice(2);
const subcmd = rest[0] ?? "";

if (subcmd === "devices") {
  const list = (process.env.FAKE_DEVICES ?? "emu1").split(",").filter(Boolean);
  const body = list.length === 0 ? "" : list.map(s => s + "\\tdevice").join("\\n") + "\\n";
  process.stdout.write("List of devices attached\\n" + body + "\\n");
  process.exit(0);
}

if (subcmd === "shell") {
  const cmd = rest.slice(1).join(" ");
  if (cmd.startsWith("am start")) {
    const mode = process.env.FAKE_AM_START ?? "success";
    if (mode === "fail_text") {
      // 真失败：以 "Error:" 开头
      process.stdout.write("Starting: Intent {}\\nError: Activity not started, unable to resolve Intent {}\\n");
      process.exit(0);
    }
    if (mode === "warning_already_top") {
      // 浏览器/Activity 已在前台时的 am 输出，stdout 是 Starting:、stderr 是 Warning:
      // 含 "Activity not started" 但属于成功（intent 已交付）
      process.stdout.write("Starting: Intent { dat=... }\\n");
      process.stderr.write("Warning: Activity not started, intent has been delivered to currently running top-most instance.\\n");
      process.exit(0);
    }
    if (mode === "fail_code") {
      process.stderr.write("error: device offline\\n");
      process.exit(1);
    }
    process.stdout.write("Starting: Intent { dat=... }\\n");
    process.exit(0);
  }
  if (cmd.startsWith("am broadcast")) {
    const mode = process.env.FAKE_BROADCAST ?? "fp";
    if (mode === "fp") {
      process.stdout.write('Broadcasting: Intent {}\\nBroadcast completed: result=0, data="FP:/sdcard/x.txt"\\n');
      process.exit(0);
    }
    if (mode === "inline") {
      process.stdout.write('Broadcasting: Intent {}\\nBroadcast completed: result=0, data="aGVsbG8="\\n');
      process.exit(0);
    }
    if (mode === "empty") {
      process.stdout.write("Broadcasting: Intent {}\\nBroadcast completed: result=0\\n");
      process.exit(0);
    }
    if (mode === "error") {
      process.stderr.write("error: broadcast failed\\n");
      process.exit(1);
    }
  }
}

process.exit(0);
`;

let workDir = "";
let adbPath = "";
let logPath = "";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configFake(opts: { devices?: string; amStart?: string; broadcast?: string } = {}): void {
  setEnv("FAKE_DEVICES", opts.devices ?? "emu1");
  setEnv("FAKE_AM_START", opts.amStart);
  setEnv("FAKE_BROADCAST", opts.broadcast);
  writeFileSync(logPath, "");
}

function readCalls(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as string[]);
}

function findBroadcastCall(calls: string[][]): string | null {
  for (const call of calls) {
    const joined = call.join(" ");
    if (joined.includes("am broadcast")) {
      return call.find((s) => s.includes("am broadcast")) ?? null;
    }
  }
  return null;
}

async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const origLog = console.log;
  let buf = "";
  console.log = (...args: unknown[]) => {
    buf += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  };
  try {
    const value = await fn();
    return { value, out: buf };
  } finally {
    console.log = origLog;
  }
}

describe("schema unit tests", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cl-schema-test-"));
    adbPath = join(workDir, "fake-adb.mjs");
    logPath = join(workDir, "calls.log");
    writeFileSync(adbPath, FAKE_ADB_SRC, { mode: 0o755 });
    setEnv("ADB_PATH", adbPath);
    setEnv("FAKE_ADB_LOG", logPath);
  });

  afterEach(() => {
    setEnv("ADB_PATH", undefined);
    setEnv("FAKE_ADB_LOG", undefined);
    setEnv("FAKE_DEVICES", undefined);
    setEnv("FAKE_AM_START", undefined);
    setEnv("FAKE_BROADCAST", undefined);
    rmSync(workDir, { recursive: true, force: true });
  });

  test("--help 输出 usage 并返回 0", async () => {
    configFake();
    const { value, out } = await captureLog(() => runSchemaCli(["--help"]));
    assert.equal(value, 0);
    assert.match(out, /用法/);
    assert.match(out, /--device/);
  });

  test("缺少 url 时打印 usage 并返回 1", async () => {
    configFake();
    const { value, out } = await captureLog(() => runSchemaCli([]));
    assert.equal(value, 1);
    assert.match(out, /用法/);
  });

  test("am start 成功 → 不走 fallback", async () => {
    configFake({ amStart: "success" });
    const result = await runSchema({ url: "https://example.com" });
    assert.equal(result.primary.ok, true);
    assert.equal(result.fallback, undefined);
    assert.equal(result.device, "emu1");
    // 仅 devices + shell am start 两次调用
    const calls = readCalls();
    assert.equal(findBroadcastCall(calls), null, "成功路径不应触发 broadcast");
  });

  test("am start exit=0 但 stderr 含 'Error: Activity not started' → 触发 fallback", async () => {
    configFake({ amStart: "fail_text", broadcast: "fp" });
    const result = await runSchema({ url: "snssdk1128://feed" });
    assert.equal(result.primary.ok, false);
    assert.ok(result.fallback, "应触发 fallback");
    assert.equal(result.fallback!.ok, true);
    assert.equal(result.fallback!.payload.kind, "file");
    if (result.fallback!.payload.kind === "file") {
      assert.equal(result.fallback!.payload.path, "/sdcard/x.txt");
    }
  });

  // 回归：浏览器已在前台时 am 打印 "Warning: Activity not started, intent has been delivered"。
  // 这是 **成功** 的提示，但旧版本 amStartSucceeded 误判为失败。锁住正确行为。
  test("am 输出 'Warning: Activity not started, intent has been delivered' → 视为主路径成功", async () => {
    configFake({ amStart: "warning_already_top" });
    const result = await runSchema({ url: "https://example.com" });
    assert.equal(result.primary.ok, true, "Warning 行不应被判失败");
    assert.equal(result.fallback, undefined, "成功路径不应触发 fallback");
    // 没有 broadcast 调用
    assert.equal(findBroadcastCall(readCalls()), null);
  });

  test("am start exit ≠ 0 → 触发 fallback（empty payload）", async () => {
    configFake({ amStart: "fail_code", broadcast: "empty" });
    const result = await runSchema({ url: "x://y" });
    assert.equal(result.primary.ok, false);
    assert.ok(result.fallback);
    assert.equal(result.fallback!.payload.kind, "empty");
  });

  test("--no-fallback 时 am start 失败也不触发 broadcast", async () => {
    configFake({ amStart: "fail_text" });
    const result = await runSchema({ url: "x://y", fallback: false });
    assert.equal(result.primary.ok, false);
    assert.equal(result.fallback, undefined);
    assert.equal(findBroadcastCall(readCalls()), null);
  });

  test("--save-to-file 时 fallback broadcast 携带 KEY_SAVE_TO_FILE=true", async () => {
    configFake({ amStart: "fail_code", broadcast: "empty" });
    await runSchema({ url: "x://y", saveToFile: true });
    const cmd = findBroadcastCall(readCalls());
    assert.ok(cmd, "应有一次 broadcast 调用");
    const m = cmd!.match(/--es codeLocator_shell_args '([^']+)'/u);
    assert.ok(m, "应能从命令里解析出 base64 args");
    const decoded = decodeShellArgs(m![1]);
    assert.equal(decoded.codeLocator_schema, "x://y");
    assert.equal(decoded.codeLocator_save_to_file, "true");
  });

  test("默认不携带 KEY_SAVE_TO_FILE / KEY_ASYNC", async () => {
    configFake({ amStart: "fail_code", broadcast: "fp" });
    await runSchema({ url: "snssdk1128://feed?tab_id=1" });
    const cmd = findBroadcastCall(readCalls());
    assert.ok(cmd);
    const decoded = decodeShellArgs(cmd!.match(/--es codeLocator_shell_args '([^']+)'/u)![1]);
    assert.equal(Object.keys(decoded).length, 1, `只应有 KEY_SCHEMA，实际 keys=${Object.keys(decoded)}`);
    assert.equal(decoded.codeLocator_schema, "snssdk1128://feed?tab_id=1");
  });

  test("broadcast 使用 ACTION_PROCESS_SCHEMA 常量", async () => {
    configFake({ amStart: "fail_code", broadcast: "fp" });
    await runSchema({ url: "x://y" });
    const cmd = findBroadcastCall(readCalls());
    assert.ok(cmd);
    assert.match(cmd!, /-a com\.bytedance\.tools\.codelocator\.action_process_schema/u);
  });

  test("多设备无 --device → status=error code=MULTIPLE_DEVICES", async () => {
    configFake({ devices: "emu1,emu2" });
    const { value, out } = await captureLog(() => runSchemaCli(["https://example.com"]));
    assert.equal(value, 1);
    const parsed = JSON.parse(out) as { status: string; code: string; candidates: string[] };
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "MULTIPLE_DEVICES");
    assert.deepEqual(parsed.candidates, ["emu1", "emu2"]);
  });

  test("runSchemaCli 成功路径 → JSON 结构含 status/device/primary", async () => {
    configFake({ amStart: "success" });
    const { value, out } = await captureLog(() => runSchemaCli(["https://example.com"]));
    assert.equal(value, 0);
    const parsed = JSON.parse(out) as { status: string; device: string; primary: { ok: boolean } };
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.device, "emu1");
    assert.equal(parsed.primary.ok, true);
  });

  test("CLI --schema 与 positional 等价", async () => {
    configFake({ amStart: "success" });
    const a = await captureLog(() => runSchemaCli(["--schema", "x://a"]));
    const b = await captureLog(() => runSchemaCli(["x://a"]));
    assert.equal((JSON.parse(a.out) as { status: string }).status, "ok");
    assert.equal((JSON.parse(b.out) as { status: string }).status, "ok");
  });

  test("--device <serial> 透传：显式 serial 校验在线后被采用", async () => {
    configFake({ devices: "emu1,emu7", amStart: "success" });
    const result = await runSchema({ url: "x://y", device: "emu7" });
    assert.equal(result.device, "emu7");
    // am start 调用应带 -s emu7
    const calls = readCalls();
    const amStartCall = calls.find((c) => c.join(" ").includes("am start"));
    assert.ok(amStartCall);
    assert.equal(amStartCall![0], "-s");
    assert.equal(amStartCall![1], "emu7");
  });

  test("schema 含特殊字符（& ? 中文 空格）→ am start 单引号包裹，broadcast base64 安全", async () => {
    configFake({ amStart: "fail_code", broadcast: "fp" });
    const url = "aweme://share?title=中文测试&q=hello world";
    await runSchema({ url });
    const calls = readCalls();
    const amStartCall = calls.find((c) => c.join(" ").includes("am start"));
    assert.ok(amStartCall);
    // shell 参数里 url 必须被单引号包裹
    const shellArg = amStartCall!.find((s) => s.includes("am start"))!;
    assert.match(shellArg, /am start -d '[^']*中文测试[^']*'/u);
    // broadcast base64 round-trip 还原原 url
    const cmd = findBroadcastCall(calls)!;
    const decoded = decodeShellArgs(cmd.match(/--es codeLocator_shell_args '([^']+)'/u)![1]);
    assert.equal(decoded.codeLocator_schema, url);
  });
});
