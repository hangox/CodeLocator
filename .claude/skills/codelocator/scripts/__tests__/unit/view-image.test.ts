// scripts/__tests__/unit/view-image.test.ts
// view-image.ts 的单元测试。零真机依赖：通过临时 fake-adb + ADB_PATH 覆盖 adb，
// 并用 FAKE_ADB_LOG 记录每次调用，断言 CodeLocator 反向截图协议与错误路径。
//
// 跑法：node --experimental-strip-types --test scripts/__tests__/unit/view-image.test.ts

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
// @ts-ignore Node 内置
import { spawnSync } from "node:child_process";

import { buildOperateData, parseArgs, runViewImage, ViewImageError } from "../../view-image.ts";
import { decodeShellArgs } from "../../shared/codec.ts";
import { DeviceSelectError } from "../../shared/device.ts";

declare const process: { env: Record<string, string | undefined>; execPath: string };

const VIEW_IMAGE_TS = new URL("../../view-image.ts", import.meta.url).pathname;
const REMOTE_IMAGE = "/sdcard/Download/codeLocator_image.png";

// 行为通过 env 切换：
//   FAKE_DEVICES    逗号分隔 serial 列表，默认 emu1
//   FAKE_BROADCAST  success | sdk_error | fail，默认 success
//   FAKE_PULL       success | fail，默认 success
//   FAKE_ADB_LOG    每次调用追加一行 JSON(argv)，供断言用
const FAKE_ADB_SRC = `#!/usr/bin/env node
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  if (cmd.startsWith("rm -f ")) {
    process.exit(0);
  }
  if (cmd.startsWith("am broadcast")) {
    const mode = process.env.FAKE_BROADCAST ?? "success";
    if (mode === "fail") {
      process.stderr.write("error: broadcast failed; receiver missing\\n");
      process.exit(1);
    }
    if (mode === "sdk_error") {
      process.stdout.write('Broadcasting: Intent {}\\nBroadcast completed: result=0, data="Error:SDK not integrated"\\n');
      process.exit(0);
    }
    process.stdout.write("Broadcasting: Intent {}\\nBroadcast completed: result=0\\n");
    process.exit(0);
  }
}

if (subcmd === "pull") {
  const mode = process.env.FAKE_PULL ?? "success";
  if (mode === "fail") {
    process.stderr.write("remote object does not exist: " + rest[1] + "\\n");
    process.exit(1);
  }
  const local = rest[2];
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  process.stdout.write(rest[1] + ": 1 file pulled\\n");
  process.exit(0);
}

process.exit(0);
`;

let workDir = "";
let adbPath = "";
let logPath = "";
let outPath = "";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configFake(opts: { devices?: string; broadcast?: string; pull?: string } = {}): void {
  setEnv("FAKE_DEVICES", opts.devices ?? "emu1");
  setEnv("FAKE_BROADCAST", opts.broadcast);
  setEnv("FAKE_PULL", opts.pull);
  writeFileSync(logPath, "");
}

function readCalls(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as string[]);
}

function findShellCmd(calls: string[][], needle: string): string | null {
  for (const call of calls) {
    const cmd = call.find((s) => s.includes(needle));
    if (cmd) return cmd;
  }
  return null;
}

function broadcastCmd(): string {
  const cmd = findShellCmd(readCalls(), "am broadcast");
  assert.ok(cmd, "应有 am broadcast 调用");
  return cmd!;
}

function decodeBroadcastOperateData(cmd: string): Record<string, unknown> {
  const match = cmd.match(/--es codeLocator_shell_args '([^']+)'/u);
  assert.ok(match, `应能从 broadcast 命令解析 codeLocator_shell_args: ${cmd}`);
  const decoded = decodeShellArgs(match![1]);
  assert.deepEqual(Object.keys(decoded), ["codeLocator_change_view"]);
  return JSON.parse(decoded.codeLocator_change_view) as Record<string, unknown>;
}

function assertViewImageError(err: unknown, code: string): void {
  assert.ok(err instanceof ViewImageError, `应抛 ViewImageError，实际 ${String(err)}`);
  assert.equal((err as ViewImageError).code, code);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["--experimental-strip-types", VIEW_IMAGE_TS, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ADB_PATH: adbPath, FAKE_ADB_LOG: logPath },
  });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

describe("view-image unit tests", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cl-view-image-test-"));
    adbPath = join(workDir, "fake-adb.mjs");
    logPath = join(workDir, "calls.log");
    outPath = join(workDir, "view.png");
    writeFileSync(adbPath, FAKE_ADB_SRC, { mode: 0o755 });
    setEnv("ADB_PATH", adbPath);
    setEnv("FAKE_ADB_LOG", logPath);
  });

  afterEach(() => {
    setEnv("ADB_PATH", undefined);
    setEnv("FAKE_ADB_LOG", undefined);
    setEnv("FAKE_DEVICES", undefined);
    setEnv("FAKE_BROADCAST", undefined);
    setEnv("FAKE_PULL", undefined);
    rmSync(workDir, { recursive: true, force: true });
  });

  test("协议正确性：screenshot → VB/X，memAddr 04211def 转十进制", async () => {
    configFake();
    await runViewImage({ memAddr: "04211def", type: "screenshot", output: outPath });
    const data = decodeBroadcastOperateData(broadcastCmd());
    assert.deepEqual(data, { aa: "V", d4: 69_279_215, d5: [{ d7: "VB", d8: "X" }] });
  });

  test("协议正确性：all → DLB/X", async () => {
    configFake();
    await runViewImage({ memAddr: "04211def", type: "all", output: outPath });
    assert.deepEqual(decodeBroadcastOperateData(broadcastCmd()), { aa: "V", d4: 69_279_215, d5: [{ d7: "DLB", d8: "X" }] });
  });

  test("协议正确性：foreground → DLB/OF", async () => {
    configFake();
    await runViewImage({ memAddr: "04211def", type: "foreground", output: outPath });
    assert.deepEqual(decodeBroadcastOperateData(broadcastCmd()), { aa: "V", d4: 69_279_215, d5: [{ d7: "DLB", d8: "OF" }] });
  });

  test("协议正确性：background → DLB/OB", async () => {
    configFake();
    await runViewImage({ memAddr: "04211def", type: "background", output: outPath });
    assert.deepEqual(decodeBroadcastOperateData(broadcastCmd()), { aa: "V", d4: 69_279_215, d5: [{ d7: "DLB", d8: "OB" }] });
  });

  test("broadcast 使用 action_change_view_info 且先清理远端临时图片再 pull", async () => {
    configFake({ devices: "emu9" });
    await runViewImage({ memAddr: "0x1", type: "screenshot", device: "emu9", output: outPath });
    const calls = readCalls();
    const cleanup = findShellCmd(calls, "rm -f");
    const bc = findShellCmd(calls, "am broadcast");
    const pullCall = calls.find((c) => c.includes("pull"));
    assert.match(bc!, /-a com\.bytedance\.tools\.codelocator\.action_change_view_info/u);
    assert.equal(cleanup, `rm -f '${REMOTE_IMAGE}'`);
    assert.ok(pullCall, "应有 adb pull 调用");
    assert.deepEqual(pullCall!.slice(0, 5), ["-s", "emu9", "pull", REMOTE_IMAGE, outPath]);
  });

  test("buildOperateData：四种 type 返回结构", () => {
    assert.deepEqual(buildOperateData("1", "screenshot"), { aa: "V", d4: 1, d5: [{ d7: "VB", d8: "X" }] });
    assert.deepEqual(buildOperateData("1", "all"), { aa: "V", d4: 1, d5: [{ d7: "DLB", d8: "X" }] });
    assert.deepEqual(buildOperateData("1", "foreground"), { aa: "V", d4: 1, d5: [{ d7: "DLB", d8: "OF" }] });
    assert.deepEqual(buildOperateData("1", "background"), { aa: "V", d4: 1, d5: [{ d7: "DLB", d8: "OB" }] });
  });

  test("buildOperateData：memAddr 支持普通、0x 前缀、大写字母", () => {
    assert.equal(buildOperateData("ff", "screenshot").d4, 255);
    assert.equal(buildOperateData("0x10", "screenshot").d4, 16);
    assert.equal(buildOperateData("0XABCDEF", "screenshot").d4, 11_259_375);
  });

  test("parseArgs：正常参数、pretty、长等号形态", () => {
    const opts = parseArgs(["--mem=04211def", "--type=foreground", "--device=SERIAL", "--output=/tmp/a.png", "--pretty"]);
    assert.deepEqual(opts, { memAddr: "04211def", type: "foreground", device: "SERIAL", output: "/tmp/a.png", pretty: true, help: false });
  });

  test("parseArgs：--device / --serial / -s 别名", () => {
    assert.equal(parseArgs(["--device", "A"]).device, "A");
    assert.equal(parseArgs(["--serial", "B"]).device, "B");
    assert.equal(parseArgs(["-s", "C"]).device, "C");
  });

  test("parseArgs：--output / -o 别名", () => {
    assert.equal(parseArgs(["--output", "a.png"]).output, "a.png");
    assert.equal(parseArgs(["-o", "b.png"]).output, "b.png");
  });

  test("parseArgs：缺少参数值与未知参数报错", () => {
    assert.throws(() => parseArgs(["--mem"]), (e: unknown) => { assertViewImageError(e, "MISSING_ARG"); return true; });
    assert.throws(() => parseArgs(["--unknown"]), (e: unknown) => { assertViewImageError(e, "UNKNOWN_OPTION"); return true; });
  });

  test("parseArgs：无效 type 参数报错", () => {
    assert.throws(() => parseArgs(["--type", "bad"]), (e: unknown) => { assertViewImageError(e, "INVALID_TYPE"); return true; });
  });

  test("CLI：缺少 --mem 与 --type 时输出稳定错误 JSON", () => {
    configFake();
    const missingMem = runCli(["--type", "screenshot"]);
    assert.equal(missingMem.status, 1);
    assert.deepEqual(JSON.parse(missingMem.stdout), { status: "error", code: "MISSING_MEM", message: "缺少必需参数 --mem" });

    const missingType = runCli(["--mem", "1"]);
    assert.equal(missingType.status, 1);
    assert.deepEqual(JSON.parse(missingType.stdout), { status: "error", code: "MISSING_TYPE", message: "缺少必需参数 --type" });
  });

  test("错误路径：无效 memAddr（非十六进制）", async () => {
    configFake();
    await assert.rejects(() => runViewImage({ memAddr: "not-hex", type: "screenshot", output: outPath }), (e: unknown) => { assertViewImageError(e, "INVALID_MEM"); return true; });
  });

  test("错误路径：broadcast 失败（SDK 未集成 / receiver 缺失）", async () => {
    configFake({ broadcast: "fail" });
    await assert.rejects(() => runViewImage({ memAddr: "1", type: "screenshot", output: outPath }), (e: unknown) => { assertViewImageError(e, "BROADCAST_FAILED"); return true; });
  });

  test("错误路径：SDK 显式返回错误", async () => {
    configFake({ broadcast: "sdk_error" });
    await assert.rejects(() => runViewImage({ memAddr: "1", type: "screenshot", output: outPath }), (e: unknown) => { assertViewImageError(e, "SDK_ERROR"); return true; });
  });

  test("错误路径：pull 失败（文件不存在）", async () => {
    configFake({ pull: "fail" });
    await assert.rejects(() => runViewImage({ memAddr: "1", type: "screenshot", output: outPath }), (e: unknown) => { assertViewImageError(e, "PULL_IMAGE_FAILED"); return true; });
  });

  test("错误路径：无设备连接", async () => {
    configFake({ devices: "" });
    await assert.rejects(() => runViewImage({ memAddr: "1", type: "screenshot", output: outPath }), (e: unknown) => {
      assert.ok(e instanceof DeviceSelectError);
      assert.equal((e as DeviceSelectError).code, "NO_DEVICE");
      return true;
    });
  });

  test("错误路径：多设备未指定 --device", async () => {
    configFake({ devices: "emu1,emu2" });
    await assert.rejects(() => runViewImage({ memAddr: "1", type: "screenshot", output: outPath }), (e: unknown) => {
      assert.ok(e instanceof DeviceSelectError);
      assert.equal((e as DeviceSelectError).code, "MULTIPLE_DEVICES");
      assert.deepEqual((e as DeviceSelectError).candidates, ["emu1", "emu2"]);
      return true;
    });
  });

  test("输出格式：CLI 成功 JSON 包含 status/device/type/memAddr/output", () => {
    configFake({ devices: "emu1" });
    const res = runCli(["--mem", "0XABC", "--type", "background", "--output", outPath]);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout) as { status: string; device: string; type: string; memAddr: string; output: string };
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.device, "emu1");
    assert.equal(parsed.type, "background");
    assert.equal(parsed.memAddr, "abc");
    assert.equal(parsed.output, outPath);
  });

  test("输出格式：CLI 失败 JSON 包含 status/code/message", () => {
    configFake({ devices: "" });
    const res = runCli(["--mem", "1", "--type", "screenshot", "--output", outPath]);
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.stdout) as { status: string; code: string; message: string };
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "NO_DEVICE");
    assert.equal(typeof parsed.message, "string");
    assert.ok(parsed.message.length > 0);
  });
});
