#!/usr/bin/env -S node --experimental-strip-types
// scripts/view-image.ts
// 反向操作：通过 CodeLocator SDK 渲染指定 View 的 Bitmap，并 pull 到本地 PNG。
//
// 对应 IDE 插件右键菜单：
//   - 复制当前View截图 → screenshot: VB/X
//   - View绘制内容     → all:        DLB/X
//   - View绘制前景     → foreground: DLB/OF
//   - View绘制背景     → background: DLB/OB

// @ts-ignore Node 内置
import { mkdir } from "node:fs/promises";
// @ts-ignore Node 内置
import { dirname, resolve } from "node:path";

import { broadcast, pull, shell, type AdbResult } from "./shared/adb.ts";
import { encodeShellArgs, parseBroadcastResult, type BroadcastResultPayload } from "./shared/codec.ts";
import { DeviceSelectError, pickDevice } from "./shared/device.ts";

declare const process: { argv: string[]; exitCode?: number };

type ViewImageType = "screenshot" | "all" | "foreground" | "background";
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

const ACTION_CHANGE_VIEW_INFO = "com.bytedance.tools.codelocator.action_change_view_info";
const KEY_CHANGE_VIEW = "codeLocator_change_view";
const DEVICE_IMAGE_PATH = "/sdcard/Download/codeLocator_image.png";

const TYPE_TO_EDIT: Record<ViewImageType, { readonly editType: "VB" | "DLB"; readonly editCommand: "X" | "OF" | "OB" }> = {
  screenshot: { editType: "VB", editCommand: "X" },
  all: { editType: "DLB", editCommand: "X" },
  foreground: { editType: "DLB", editCommand: "OF" },
  background: { editType: "DLB", editCommand: "OB" },
};

export interface ViewImageCliOptions {
  readonly memAddr: string | null;
  readonly type: ViewImageType | null;
  readonly device: string | null;
  readonly output: string | null;
  readonly pretty: boolean;
  readonly help: boolean;
}

export interface ViewImageOptions {
  readonly memAddr: string;
  readonly type: ViewImageType;
  readonly device?: string | null;
  readonly output?: string | null;
}

export interface ViewImageResult {
  readonly status: "ok";
  readonly device: string;
  readonly type: ViewImageType;
  readonly memAddr: string;
  readonly output: string;
  readonly remotePath: string;
  readonly broadcast: {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly payload: BroadcastResultPayload;
  };
  readonly cleanup: { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
  readonly pull: { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
}

export class ViewImageError extends Error {
  readonly code: string;
  readonly extra: JsonObject;

  constructor(code: string, message: string, extra: JsonObject = {}) {
    super(message);
    this.name = "ViewImageError";
    this.code = code;
    this.extra = extra;
  }
}

function printJson(value: JsonObject, pretty: boolean): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : 0));
}

function usage(): string {
  return `Usage: node view-image.ts --mem <memAddr> --type screenshot|all|foreground|background [options]

  通过 CodeLocator SDK 渲染指定 View 的 Bitmap，并 pull 到本地 PNG。

Options:
  --mem <memAddr>        View 的 memAddr 十六进制字符串，例如 04211def
  --type <type>          screenshot | all | foreground | background
  --device <serial>      指定 adb 设备 serial（多设备必需）
  --output <path.png>    本地输出路径（默认 ./view-image-<type>-<memAddr>.png）
  --pretty               美化 JSON 输出
  --help                 显示本帮助
`;
}

export function parseArgs(argv: string[]): ViewImageCliOptions {
  let memAddr: string | null = null;
  let type: ViewImageType | null = null;
  let device: string | null = null;
  let output: string | null = null;
  let pretty = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eat = (): string => {
      const next = argv[i + 1];
      if (!next) throw new ViewImageError("MISSING_ARG", `${a} 缺少参数值`);
      i += 1;
      return next;
    };

    if (a === "--help" || a === "-h") help = true;
    else if (a === "--pretty") pretty = true;
    else if (a === "--mem") memAddr = eat();
    else if (a.startsWith("--mem=")) memAddr = a.slice("--mem=".length);
    else if (a === "--type") type = parseType(eat());
    else if (a.startsWith("--type=")) type = parseType(a.slice("--type=".length));
    else if (a === "--device" || a === "--serial" || a === "-s") device = eat();
    else if (a.startsWith("--device=")) device = a.slice("--device=".length);
    else if (a.startsWith("--serial=")) device = a.slice("--serial=".length);
    else if (a === "--output" || a === "-o") output = eat();
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
    else throw new ViewImageError("UNKNOWN_OPTION", `未知参数: ${a}`);
  }

  return { memAddr, type, device, output, pretty, help };
}

function parseType(value: string): ViewImageType {
  if (value === "screenshot" || value === "all" || value === "foreground" || value === "background") return value;
  throw new ViewImageError("INVALID_TYPE", `--type 只支持 screenshot|all|foreground|background，当前为: ${value}`);
}

function normalizeMemAddr(value: string): string {
  const trimmed = value.trim().replace(/^0x/iu, "");
  if (!/^[0-9a-f]{1,8}$/iu.test(trimmed)) {
    throw new ViewImageError("INVALID_MEM", `--mem 必须是 1~8 位十六进制字符串，当前为: ${value}`);
  }
  return trimmed.toLowerCase();
}

function memAddrToSignedInt32(memAddr: string): number {
  const normalized = normalizeMemAddr(memAddr);
  const unsigned = Number.parseInt(normalized, 16);
  return unsigned > 0x7FFFFFFF ? unsigned - 0x100000000 : unsigned;
}

function buildDefaultOutput(type: ViewImageType, memAddr: string): string {
  return resolve(`view-image-${type}-${memAddr}.png`);
}

export function buildOperateData(memAddr: string, type: ViewImageType): JsonObject {
  const itemId = memAddrToSignedInt32(memAddr);
  const edit = TYPE_TO_EDIT[type];
  return {
    aa: "V",
    d4: itemId,
    d5: [{ d7: edit.editType, d8: edit.editCommand }],
  };
}

function adbOk(result: AdbResult): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

export async function runViewImage(opts: ViewImageOptions): Promise<ViewImageResult> {
  const memAddr = normalizeMemAddr(opts.memAddr);
  const output = resolve(opts.output ?? buildDefaultOutput(opts.type, memAddr));
  const serial = await pickDevice(opts.device ?? null);

  const cleanup = await shell(`rm -f '${DEVICE_IMAGE_PATH}'`, { serial });
  if (cleanup.code !== 0) {
    throw new ViewImageError("CLEANUP_FAILED", `删除设备旧临时图片失败: ${cleanup.stderr || cleanup.stdout}`, { device: serial });
  }

  const operateData = buildOperateData(memAddr, opts.type);
  const encoded = encodeShellArgs({ [KEY_CHANGE_VIEW]: JSON.stringify(operateData) });
  const bc = await broadcast(ACTION_CHANGE_VIEW_INFO, encoded, { serial, timeoutMs: 60_000 });
  if (bc.code !== 0) {
    throw new ViewImageError("BROADCAST_FAILED", `am broadcast 返回码 ${bc.code}: ${bc.stderr || bc.stdout}`, { device: serial, raw: bc.raw });
  }

  const payload = parseBroadcastResult(bc.raw);
  if (payload.kind === "error") {
    throw new ViewImageError("SDK_ERROR", `SDK 返回错误: ${payload.message}`, { device: serial, raw: bc.raw });
  }

  await mkdir(dirname(output), { recursive: true });
  // TODO: V2 应解码 broadcast response 中的 gzip+base64 OperateResponse，从 ResultKey.FILE_PATH 取实际图片路径，以兼容旧 SDK 版本
  const pulled = await pull(DEVICE_IMAGE_PATH, output, { serial, timeoutMs: 60_000 });
  if (pulled.code !== 0) {
    throw new ViewImageError("PULL_IMAGE_FAILED", `pull 图片失败: ${pulled.stderr || pulled.stdout}`, {
      device: serial,
      remotePath: DEVICE_IMAGE_PATH,
      output,
    });
  }

  return {
    status: "ok",
    device: serial,
    type: opts.type,
    memAddr,
    output,
    remotePath: DEVICE_IMAGE_PATH,
    broadcast: { ...adbOk(bc), payload },
    cleanup: adbOk(cleanup),
    pull: adbOk(pulled),
  };
}

async function main(): Promise<void> {
  let opts: ViewImageCliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    printJson(toErrorJson(e), false);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.memAddr) {
    printJson({ status: "error", code: "MISSING_MEM", message: "缺少必需参数 --mem" }, opts.pretty);
    process.exitCode = 1;
    return;
  }
  if (!opts.type) {
    printJson({ status: "error", code: "MISSING_TYPE", message: "缺少必需参数 --type" }, opts.pretty);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runViewImage({ memAddr: opts.memAddr, type: opts.type, device: opts.device, output: opts.output });
    printJson(result as unknown as JsonObject, opts.pretty);
  } catch (e) {
    printJson(toErrorJson(e), opts.pretty);
    process.exitCode = 1;
  }
}

function toErrorJson(e: unknown): JsonObject {
  if (e instanceof ViewImageError) {
    return { status: "error", code: e.code, message: e.message, ...e.extra };
  }
  if (e instanceof DeviceSelectError) {
    return { status: "error", code: e.code, message: e.message, candidates: e.candidates };
  }
  if (e instanceof Error) {
    return { status: "error", code: e.name || "ERROR", message: e.message };
  }
  return { status: "error", code: "UNKNOWN", message: String(e) };
}

// 仅直接执行时运行 CLI；被测试 import 时不触发。
const entry = process.argv[1] ?? "";
if (import.meta.url.endsWith("/view-image.ts") && entry.endsWith("/view-image.ts")) {
  main();
}
