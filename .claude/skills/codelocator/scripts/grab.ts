#!/usr/bin/env node
// scripts/grab.ts
// 反向操作 #1：grab — 在目标 App 前台时抓取一次 UI 布局 + 截图，落盘成 `.codeLocator` 历史文件。
//
// 链路（对应 docs/01 + 04 + CodeLocatorPlugin/ScreenPanel/DeviceManager）：
//   1) pickDevice → probeProvider 确认 SDK 已集成
//   2) 前台保护：dumpsys mResumedActivity 必须指向目标 package
//   3) am broadcast ACTION_DEBUG_LAYOUT_INFO --es codeLocator_shell_args '<base64>'
//      args = { KEY_SAVE_TO_FILE: true, KEY_NEED_COLOR: false }
//   4) 解析 stdout：FP:<path> → adb pull；data="<base64>" → 直接用
//   5) gunzip + base64 decode → BaseResponse JSON
//   6) screencap -p → 本地 PNG
//   7) 拼装成 .codeLocator 二进制（CodeLocatorInfo.toBytes 格式）并保存到 ~/.codeLocator_main/historyFile/
//
// 输出 JSON manifest（成功）：
//   { status: "ok", historyFile: "<abs path>", package, activity, sizeBytes, ... }
//
// CLI:
//   node grab.ts [--device <serial>] [--package <pkg>] [--output-dir <dir>] [--no-foreground-check] [--pretty]
//
// 手测：
//   - 连一台 adb 设备 + 启动集成了 CodeLocator SDK 的 App 到前台
//   - `node ~/.claude/skills/codelocator/scripts/grab.ts --pretty`
//   - 检查 stdout JSON 中 historyFile 路径存在，且能被 parse-codelocator-file.ts 解析
//
// 无设备时也应能跑到 device check 阶段并打印结构化错误 JSON。

// @ts-ignore Node 内置
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
// @ts-ignore Node 内置
import { join } from "node:path";
// @ts-ignore Node 内置
import { homedir, tmpdir } from "node:os";
// @ts-ignore Node 内置
import { gunzipSync } from "node:zlib";
// @ts-ignore Node 内置
import { Buffer } from "node:buffer";

import { shell, broadcast, pull, getApiLevel, getResumedActivity } from "./shared/adb.ts";
import { encodeShellArgs, parseBroadcastResult, type BroadcastArgs } from "./shared/codec.ts";
import { pickDevice, DeviceSelectError } from "./shared/device.ts";
import { probeProvider } from "./shared/provider.ts";

declare const process: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number };

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

export interface GrabCliOptions {
  device: string | null;
  packageFilter: string | null;
  outputDir: string;
  skipForegroundCheck: boolean;
  needColor: boolean;
  pretty: boolean;
  help: boolean;
}

export class GrabError extends Error {
  readonly code: string;
  readonly extra: JsonObject;
  constructor(code: string, message: string, extra: JsonObject = {}) {
    super(message);
    this.name = "GrabError";
    this.code = code;
    this.extra = extra;
  }
}

// 与 CodeLocatorConstants.java 严格一致；不重新抽常量是因为我们就是个轻量 CLI。
const ACTION_DEBUG_LAYOUT_INFO = "com.bytedance.tools.codelocator.action_debug_layout_info";
const KEY_SAVE_TO_FILE = "codeLocator_save_to_file";
const KEY_NEED_COLOR = "codeLocator_need_color";
const TAG_HEADER = "CodeLocator";
const FALLBACK_PLUGIN_VERSION = "skill-codelocator-1";

function printJson(value: JsonObject, pretty: boolean): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : 0));
}

function helpText(): string {
  return `Usage: node grab.ts [options]

  抓取目标 App 当前页面布局 + 截图，保存为 .codeLocator 历史文件。

Options:
  --device <serial>          指定 adb 设备 serial（多设备必需）
  --package <pkg>            目标 App 包名；省略时使用前台 Activity 的 package
  --output-dir <dir>         历史文件输出目录（默认 ~/.codeLocator_main/historyFile）
  --no-foreground-check      跳过 dumpsys 前台校验（调试用，可能拿到错应用的数据）
  --need-color               同时抓取 View 颜色数据（drawable / background）；默认关闭，
                             开启会让 SDK 多遍历一遍 drawable，仅在需要色值搜索/高保真渲染时打开
  --pretty                   美化 JSON 输出
  --help                     显示本帮助
`;
}

export function parseArgs(argv: string[]): GrabCliOptions {
  const opts: GrabCliOptions = {
    device: null,
    packageFilter: null,
    outputDir: join(homedir(), ".codeLocator_main", "historyFile"),
    skipForegroundCheck: false,
    needColor: false,
    pretty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eat = (): string => {
      const next = argv[i + 1];
      if (!next) throw new GrabError("MISSING_ARG", `${a} 缺少参数值`);
      i += 1;
      return next;
    };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--pretty") opts.pretty = true;
    else if (a === "--no-foreground-check") opts.skipForegroundCheck = true;
    else if (a === "--need-color") opts.needColor = true;
    else if (a === "--device") opts.device = eat();
    else if (a.startsWith("--device=")) opts.device = a.slice("--device=".length);
    else if (a === "--package") opts.packageFilter = eat();
    else if (a.startsWith("--package=")) opts.packageFilter = a.slice("--package=".length);
    else if (a === "--output-dir") opts.outputDir = eat();
    else if (a.startsWith("--output-dir=")) opts.outputDir = a.slice("--output-dir=".length);
    else throw new GrabError("UNKNOWN_OPTION", `未知参数: ${a}`);
  }
  return opts;
}

/** 把 `pkg/.Activity` 形态拆出 package。 */
export function packageFromResumed(resumed: string | null): string | null {
  if (!resumed) return null;
  const slash = resumed.indexOf("/");
  return slash > 0 ? resumed.substring(0, slash) : null;
}

/** 生成 `<pkg><yyyy_MM_dd_HH_mm_ss>.codeLocator`（与 ShowGrabHistoryAction.saveCodeLocatorHistory 一致）。 */
export function buildHistoryFileName(pkg: string, when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts = `${when.getFullYear()}_${pad(when.getMonth() + 1)}_${pad(when.getDate())}_${pad(when.getHours())}_${pad(when.getMinutes())}_${pad(when.getSeconds())}`;
  return `${pkg}${ts}.codeLocator`;
}

/**
 * 解码 broadcast payload：gunzip(base64decode(s)) → UTF-8 字符串。
 * 协议见 docs/01 §"传输格式与恢复"。
 */
export function decodePayload(base64: string): string {
  const compressed = Buffer.from(base64, "base64");
  const decompressed = gunzipSync(compressed);
  return decompressed.toString("utf-8");
}

/**
 * 把 BaseResponse JSON 中的 data 字段（WApplication）抽出来。
 * BaseResponse 在 Gson 序列化时如果 data==null 会省略；这里保留宽容判断。
 */
export function extractApplicationJson(baseResponseJson: string): string {
  const parsed = JSON.parse(baseResponseJson) as { code?: number; msg?: string; data?: unknown };
  if (parsed.code !== undefined && parsed.code !== 0 && parsed.data === undefined) {
    throw new GrabError("SDK_ERROR", `BaseResponse 报错 (code=${parsed.code}): ${parsed.msg ?? "unknown"}`);
  }
  if (parsed.data === undefined || parsed.data === null) {
    throw new GrabError("SDK_EMPTY_DATA", `BaseResponse 没有 data 字段 (msg=${parsed.msg ?? "none"})`);
  }
  return JSON.stringify(parsed.data);
}

/** CodeLocatorInfo.toBytes 格式：tag(int+bytes) + version(int+bytes) + appJson(int+bytes) + pngBytes（其余）。 */
export function buildCodeLocatorFile(appJson: string, pngBytes: Uint8Array, pluginVersion: string): Uint8Array {
  const tagBytes = Buffer.from(TAG_HEADER, "utf-8");
  const verBytes = Buffer.from(pluginVersion, "utf-8");
  const jsonBytes = Buffer.from(appJson, "utf-8");
  const totalLen = 4 + tagBytes.length + 4 + verBytes.length + 4 + jsonBytes.length + pngBytes.length;
  const out = Buffer.alloc(totalLen);
  let offset = 0;
  offset = out.writeInt32BE(tagBytes.length, offset);
  tagBytes.copy(out, offset); offset += tagBytes.length;
  offset = out.writeInt32BE(verBytes.length, offset);
  verBytes.copy(out, offset); offset += verBytes.length;
  offset = out.writeInt32BE(jsonBytes.length, offset);
  jsonBytes.copy(out, offset); offset += jsonBytes.length;
  Buffer.from(pngBytes).copy(out, offset);
  return out;
}

/**
 * 截图：写到设备 /sdcard/codeLocator_image.png → 本地 tmp，读出后 unlink 设备文件。
 *
 * 为什么不走 `adb exec-out screencap -p` 直接管道 stdout：
 *   部分老设备 / Android 5.x ROM 的 adb shell 通道会把 \n 翻成 \r\n，使得拉回来的 PNG 头部 CRC 错位（黑屏）。
 *   先写设备临时文件再 pull 走二进制传输，CRLF 翻译被绕过。多一次写盘，但稳。
 *   doc 04 §3 的 mermaid 图也是这个 fallback 路径。
 */
async function takeScreenshot(serial: string): Promise<Uint8Array> {
  const devicePath = "/sdcard/codeLocator_image.png";
  const localPath = join(tmpdir(), `codeLocator_screen_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);
  const cap = await shell(`screencap -p ${devicePath}`, { serial });
  if (cap.code !== 0) {
    throw new GrabError("SCREENCAP_FAILED", `screencap 失败: ${cap.stderr || cap.stdout}`);
  }
  const pulled = await pull(devicePath, localPath, { serial });
  if (pulled.code !== 0) {
    throw new GrabError("SCREENCAP_PULL_FAILED", `pull 截图失败: ${pulled.stderr || pulled.stdout}`);
  }
  // 设备侧不留垃圾；忽略错误（设备可能已经被清理）。
  await shell(`rm -f ${devicePath}`, { serial }).catch(() => undefined);
  try {
    const bytes = await readFile(localPath);
    return bytes;
  } finally {
    await unlink(localPath).catch(() => undefined);
  }
}

interface PayloadFetchResult {
  applicationJson: string;
  source: "inline" | "file";
  devicePath?: string;
}

// TODO(B1): apiLevel 当前未参与决策（FP 路径从 broadcast 回执动态拿，无需根据 API 等级预测设备路径）。
//   保留参数是为后续可能的 fallback / 路径校验（例如对 API<30 时直接读 <ExternalCacheDir>/codeLocator/<file>）。
//   如果一直用不上可以删掉这个形参。
async function fetchApplicationPayload(
  serial: string,
  apiLevel: number,
  _pkg: string,
  needColor: boolean,
): Promise<PayloadFetchResult> {
  const args: BroadcastArgs = {
    [KEY_SAVE_TO_FILE]: "true", // 强制走文件回执，避免 4KB 命令行截断
    [KEY_NEED_COLOR]: needColor ? "true" : "false",
  };
  const encoded = encodeShellArgs(args);
  const result = await broadcast(ACTION_DEBUG_LAYOUT_INFO, encoded, { serial, timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new GrabError("BROADCAST_FAILED", `am broadcast 返回码 ${result.code}: ${result.stderr || result.stdout}`, {
      raw: result.raw,
    });
  }
  const payload = parseBroadcastResult(result.raw);
  switch (payload.kind) {
    case "file": {
      const localPath = join(tmpdir(), `codeLocator_payload_${Date.now()}_${Math.floor(Math.random() * 1e6)}.bin`);
      const pulled = await pull(payload.path, localPath, { serial });
      if (pulled.code !== 0) {
        throw new GrabError("PULL_PAYLOAD_FAILED", `pull 失败: ${pulled.stderr || pulled.stdout}`, { devicePath: payload.path });
      }
      try {
        const raw = (await readFile(localPath, "utf-8")).trim();
        // 设备侧文件内容是 Base64(compressed JSON)，与 inline 一致。
        const baseResponseJson = decodePayload(raw);
        return {
          applicationJson: extractApplicationJson(baseResponseJson),
          source: "file",
          devicePath: payload.path,
        };
      } finally {
        await unlink(localPath).catch(() => undefined);
        // 顺手把设备侧文件清掉，避免占空间；保留 hint：API≥30 走 /sdcard/codeLocator/，API<30 走 ExternalCacheDir。
        await shell(`rm -f ${payload.path}`, { serial }).catch(() => undefined);
        void apiLevel; // 留参数以便后续按 API 级别做 fallback；当前不用。
      }
    }
    case "inline": {
      const baseResponseJson = decodePayload(payload.data);
      return { applicationJson: extractApplicationJson(baseResponseJson), source: "inline" };
    }
    case "error":
      throw new GrabError("SDK_ERROR", `SDK 返回错误: ${payload.message}`);
    case "empty":
      // empty 可能是 async 模式或 SDK 未初始化。这里不做 async 轮询（默认插件 sync 模式），
      // 直接报错引导用户检查。
      throw new GrabError("EMPTY_RESPONSE", "广播无回执，可能 SDK 未初始化或开启了 AsyncBroadcast 模式（当前 grab 不支持 async）");
  }
}

export interface GrabSuccess {
  historyFile: string;
  package: string;
  activity: string | null;
  device: string;
  apiLevel: number;
  sizeBytes: number;
  payloadSource: "inline" | "file";
  devicePayloadPath: string | null;
  sdkVersion: string | null;
}

export async function runGrab(opts: GrabCliOptions): Promise<GrabSuccess> {
  const serial = await pickDevice(opts.device);
  const apiLevel = await getApiLevel({ serial });
  const resumed = await getResumedActivity({ serial });

  let pkg = opts.packageFilter;
  if (!pkg) {
    pkg = packageFromResumed(resumed);
  }
  if (!pkg) {
    throw new GrabError("NO_PACKAGE", "无法确定目标 package（dumpsys 拿不到 mResumedActivity；请用 --package 显式指定）");
  }

  if (!opts.skipForegroundCheck) {
    const resumedPkg = packageFromResumed(resumed);
    if (!resumedPkg) {
      throw new GrabError("FOREGROUND_UNKNOWN", "无法确定前台 Activity（dumpsys mResumedActivity 解析失败）");
    }
    if (resumedPkg !== pkg) {
      throw new GrabError(
        "WRONG_FOREGROUND",
        `目标包 ${pkg} 不在前台（当前前台 ${resumedPkg}）。先把 App 切到前台，或加 --no-foreground-check`,
      );
    }
  }

  // SDK 健康检查：若 Provider 不可用，多半是 App 没集成 SDK，提前报错比 broadcast 超时更友好。
  const health = await probeProvider(pkg, { serial });
  if (!health.available) {
    throw new GrabError("PROVIDER_UNAVAILABLE", `CodeLocatorProvider 不可用，目标 App 可能未集成 SDK: ${health.raw}`);
  }

  // 截图与 layout 抓取并发可省 1~2 秒；但截图前如果有 stopAnim 动画就会丢真实状态。
  // ScreenPanel.directGrabView 也是 "截图先 → broadcast 后" 顺序；这里保持同样。
  const png = await takeScreenshot(serial);
  const payload = await fetchApplicationPayload(serial, apiLevel, pkg, opts.needColor);

  const fileBytes = buildCodeLocatorFile(payload.applicationJson, png, health.version ?? FALLBACK_PLUGIN_VERSION);
  await mkdir(opts.outputDir, { recursive: true });
  const fileName = buildHistoryFileName(pkg, new Date());
  const filePath = join(opts.outputDir, fileName);
  await writeFile(filePath, fileBytes);

  return {
    historyFile: filePath,
    package: pkg,
    activity: resumed,
    device: serial,
    apiLevel,
    sizeBytes: fileBytes.length,
    payloadSource: payload.source,
    devicePayloadPath: payload.devicePath ?? null,
    sdkVersion: health.version,
  };
}

async function main(): Promise<void> {
  let opts: GrabCliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    printJson(toErrorJson(e), false);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    console.log(helpText());
    return;
  }

  try {
    const result = await runGrab(opts);
    printJson({
      status: "ok",
      ...result,
      next_steps: [
        `node scripts/parse-codelocator-file.ts ${result.historyFile} /tmp/codelocator-out`,
        `node scripts/list-history.ts --pretty --package ${result.package}`,
      ],
    } as unknown as JsonObject, opts.pretty);
  } catch (e) {
    printJson(toErrorJson(e), opts.pretty);
    process.exitCode = 1;
  }
}

function toErrorJson(e: unknown): JsonObject {
  if (e instanceof GrabError) {
    return { status: "error", error: { code: e.code, message: e.message, ...e.extra } };
  }
  if (e instanceof DeviceSelectError) {
    return { status: "error", error: { code: e.code, message: e.message, candidates: e.candidates } };
  }
  if (e instanceof Error) {
    return { status: "error", error: { code: e.name || "ERROR", message: e.message } };
  }
  return { status: "error", error: { code: "UNKNOWN", message: String(e) } };
}

// 仅在作为入口脚本运行时执行 main()；被测试 import 时不应触发 CLI 解析。
// 比较 import.meta.url 与 process.argv[1] 的 file:// 形态；后者在 Node strip-types 下保留为绝对路径。
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
