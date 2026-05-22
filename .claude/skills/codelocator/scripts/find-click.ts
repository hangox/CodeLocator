#!/usr/bin/env node
// find-click.ts — Find Click View Chain (MVP #3，文档 08 §5)
//
// 协议依据：docs/03 §2.2 / §4.2、docs/08 §5 + senior 已确认。
// - 发送 ACTION_GET_TOUCH_VIEW（不带任何坐标参数）→ SDK 反射读 ViewGroup.mFirstTouchTarget
//   得到"用户最近一次真实触摸"命中的 view 链（memAddr 列表）
// - 能传 x/y 的是 ACTION_MOCK_TOUCH_VIEW，但 SDK 默认未注册 IntentFilter（V2 候选）
// - TouchViewResponse 结构是 `BaseResponse<List<String>>`，data 是 memAddr 字符串数组
//
// CLI：
//   node find-click.ts [--serial <s>] [--codelocator <file>] [--pretty]
// 也接受 `--device` 作为 `--serial` 的别名。
//
// memAddr 反查：优先用 --codelocator 指定的文件；否则取
// ~/.codeLocator_main/historyFile/*.codeLocator 中 mtime 最新一个；都没有就只输出 addresses。
//
// 模块化设计：所有纯函数和 runFindClick 都 export，main 仅在直接以 CLI 方式调用时执行，
// 便于测试 import 后单独覆盖各阶段（parse / resolve / fetch / orchestrator）。

// @ts-ignore Node 内置模块由运行时保证类型
import { gunzipSync } from "node:zlib";
// @ts-ignore
import { Buffer } from "node:buffer";
// @ts-ignore
import { readFile, readdir, stat } from "node:fs/promises";
// @ts-ignore
import { homedir, tmpdir } from "node:os";
// @ts-ignore
import { join, resolve } from "node:path";

import { broadcast, pull } from "./shared/adb.ts";
import { encodeShellArgs, parseBroadcastResult } from "./shared/codec.ts";
import { pickDevice as defaultPickDevice, DeviceSelectError } from "./shared/device.ts";

declare const process: { argv: string[]; exitCode?: number };

export const ACTION_GET_TOUCH_VIEW = "com.bytedance.tools.codelocator.action_get_touch_view";
export const DEFAULT_HISTORY_DIR = join(homedir(), ".codeLocator_main", "historyFile");

// raw WApplication / WActivity / WView 短字段名。
// .codeLocator 文件里的 JSON 段是 SDK 用 Gson 默认 @SerializedName 短名直接 toJson 出来的，
// 顶层 activity 也是短名（WApplication.mActivity 的 @SerializedName("b7")），
// 不要写成 app["activity"]——那是 parse-codelocator-file.ts normalize 之后的长名。
export const RAW_KEY_ACTIVITY = "b7";      // WApplication.mActivity
export const RAW_KEY_DECOR_VIEWS = "cj";   // WActivity.decorViews
export const RAW_KEY_CHILDREN = "a";       // WView.children
export const RAW_KEY_MEM_ADDR = "af";      // WView.memAddr (Integer.toHexString(identityHashCode)，无 0x 前缀)
export const RAW_KEY_CLASS_NAME = "ag";    // WView.className
export const RAW_KEY_ID_STR = "ac";        // WView.idStr
export const RAW_KEY_LEFT = "d";
export const RAW_KEY_RIGHT = "e";
export const RAW_KEY_TOP = "f";
export const RAW_KEY_BOTTOM = "g";

export interface CliOptions {
  serial: string | null;
  codeLocatorPath: string | null;
  pretty: boolean;
}

export interface TouchViewResponse {
  code?: number;
  msg?: string | null;
  data?: string[] | null;
}

export interface ResolvedView {
  memAddr: string;
  className: string | null;
  idStr: string | null;
  bounds: { left: number | null; top: number | null; right: number | null; bottom: number | null } | null;
  path: string | null;
}

export interface Manifest {
  status: "ok";
  device: { serial: string };
  response: { code: number; msg: string | null; addressCount: number };
  addresses: string[];
  resolveSource: string | null;
  resolveError: string | null;
  resolved: ResolvedView[] | null;
  hints: string[];
}

export class SilentExit extends Error {}

export function usage(): string {
  return [
    "用法：",
    "  node find-click.ts [--serial <s>] [--codelocator <file.codeLocator>] [--pretty]",
    "",
    "行为：",
    "  - 发送 ACTION_GET_TOUCH_VIEW，拿到用户最近一次触摸命中的 view 链 memAddr 列表",
    "  - 可选反查最近一次 .codeLocator 抓取，把 memAddr 还原为 className/idStr/bounds",
    "",
    "前置：先在设备上点屏幕、再立刻跑此脚本。否则 mFirstTouchTarget 为空。",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  let serial: string | null = null;
  let codeLocatorPath: string | null = null;
  let pretty = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      throw new SilentExit();
    }
    if (a === "--pretty") { pretty = true; continue; }
    if (a === "--serial" || a === "--device") { serial = argv[++i] ?? null; continue; }
    if (a.startsWith("--serial=")) { serial = a.slice("--serial=".length); continue; }
    if (a.startsWith("--device=")) { serial = a.slice("--device=".length); continue; }
    if (a === "--codelocator") { codeLocatorPath = argv[++i] ?? null; continue; }
    if (a.startsWith("--codelocator=")) { codeLocatorPath = a.slice("--codelocator=".length); continue; }
    throw new Error(`未知参数：${a}`);
  }

  if (codeLocatorPath) codeLocatorPath = resolve(codeLocatorPath);
  return { serial, codeLocatorPath, pretty };
}

/** Base64 → gunzip → JSON.parse；inline 和 file 两种回传都走这条路径。 */
export function decodePayload(b64OrText: string): TouchViewResponse {
  const compressed = Buffer.from(b64OrText.trim(), "base64");
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json) as TouchViewResponse;
}

export async function fetchTouchViewResponse(serial: string): Promise<TouchViewResponse> {
  // 只带 KEY_SAVE_TO_FILE=true；processGetTouchViewAction 不读 x/y，加了也没用。
  const encoded = encodeShellArgs({ codeLocator_save_to_file: "true" });
  const result = await broadcast(ACTION_GET_TOUCH_VIEW, encoded, { serial });
  if (result.code !== 0) {
    throw new Error(`am broadcast 失败 (code=${result.code}): ${result.stderr || result.stdout}`);
  }
  const payload = parseBroadcastResult(result.raw);
  if (payload.kind === "inline") return decodePayload(payload.data);
  if (payload.kind === "file") {
    const localPath = join(tmpdir(), `cl_touchview_${Date.now()}.txt`);
    const pulled = await pull(payload.path, localPath, { serial });
    if (pulled.code !== 0) {
      throw new Error(`adb pull 失败：${pulled.stderr || pulled.stdout}`);
    }
    const text = await readFile(localPath, "utf-8");
    return decodePayload(text);
  }
  if (payload.kind === "error") {
    throw new Error(`SDK 端返回错误：${payload.message}`);
  }
  // empty：常见原因——App 不在前台、SDK 未集成、或开了 async 广播（MVP 不支持轮询）。
  throw new Error("broadcast 回执为空。请确认目标 App 在前台、集成了 codelocator-sdk、且未开 async 广播。");
}

export async function findLatestCodeLocatorFile(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    let bestPath: string | null = null;
    let bestMtime = -Infinity;
    for (const name of entries) {
      if (!name.endsWith(".codeLocator")) continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.mtimeMs > bestMtime) {
          bestMtime = s.mtimeMs;
          bestPath = full;
        }
      } catch { /* 跳过坏文件 */ }
    }
    return bestPath;
  } catch {
    return null;
  }
}

/** 解析 .codeLocator 二进制，返回 raw WApplication JSON。结构见 references/02。 */
export async function parseCodeLocatorApplication(filePath: string): Promise<Record<string, unknown>> {
  const buf = await readFile(filePath);
  if (buf.length < 12) throw new Error("文件太小，无法解析");
  // 三段 size-prefixed 字符串：tag / version / appJson；后面是 PNG，本场景不读
  const tagLen = buf.readInt32BE(0);
  let offset = 4 + tagLen;
  const verLen = buf.readInt32BE(offset);
  offset += 4 + verLen;
  const jsonLen = buf.readInt32BE(offset);
  offset += 4;
  if (offset + jsonLen > buf.length) throw new Error("JSON 段越界");
  const json = buf.subarray(offset, offset + jsonLen).toString("utf-8");
  return JSON.parse(json) as Record<string, unknown>;
}

function dfsCollect(node: unknown, wanted: Set<string>, found: Map<string, ResolvedView>, path: string): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const memAddr = typeof obj[RAW_KEY_MEM_ADDR] === "string" ? (obj[RAW_KEY_MEM_ADDR] as string) : null;
  if (memAddr && wanted.has(memAddr) && !found.has(memAddr)) {
    const left = typeof obj[RAW_KEY_LEFT] === "number" ? (obj[RAW_KEY_LEFT] as number) : null;
    const right = typeof obj[RAW_KEY_RIGHT] === "number" ? (obj[RAW_KEY_RIGHT] as number) : null;
    const top = typeof obj[RAW_KEY_TOP] === "number" ? (obj[RAW_KEY_TOP] as number) : null;
    const bottom = typeof obj[RAW_KEY_BOTTOM] === "number" ? (obj[RAW_KEY_BOTTOM] as number) : null;
    const hasBounds = left !== null || right !== null || top !== null || bottom !== null;
    found.set(memAddr, {
      memAddr,
      className: typeof obj[RAW_KEY_CLASS_NAME] === "string" ? (obj[RAW_KEY_CLASS_NAME] as string) : null,
      idStr: typeof obj[RAW_KEY_ID_STR] === "string" ? (obj[RAW_KEY_ID_STR] as string) : null,
      bounds: hasBounds ? { left, top, right, bottom } : null,
      path,
    });
  }
  const children = obj[RAW_KEY_CHILDREN];
  if (Array.isArray(children)) {
    children.forEach((child, i) => dfsCollect(child, wanted, found, `${path}/${i}`));
  }
}

export function resolveAddresses(app: Record<string, unknown>, addresses: string[]): ResolvedView[] {
  if (addresses.length === 0) return [];
  // .codeLocator 顶层 activity 字段的实际名字是短名 b7（Gson @SerializedName），不是 "activity"
  const activity = app[RAW_KEY_ACTIVITY] as Record<string, unknown> | undefined;
  const decorViews = activity && Array.isArray(activity[RAW_KEY_DECOR_VIEWS])
    ? (activity[RAW_KEY_DECOR_VIEWS] as unknown[])
    : [];
  const wanted = new Set(addresses);
  const found = new Map<string, ResolvedView>();
  decorViews.forEach((dv, i) => dfsCollect(dv, wanted, found, `decorViews/${i}`));
  // 保持广播返回的链顺序；未命中的也输出占位（resolved=false）
  return addresses.map((memAddr) =>
    found.get(memAddr) ?? { memAddr, className: null, idStr: null, bounds: null, path: null }
  );
}

export interface BuildManifestParams {
  serial: string;
  response: TouchViewResponse;
  /** CLI 指定的 .codeLocator 路径；为 null 时自动取 defaultHistoryDir 内 mtime 最新。 */
  codeLocatorPathHint: string | null;
  /** 自动选取目录；默认 ~/.codeLocator_main/historyFile/，测试可覆盖。 */
  defaultHistoryDir?: string;
}

/** 从 TouchViewResponse + 配置组装最终 manifest（含反查与 hints）。纯函数语义，依赖 fs。 */
export async function buildManifest(params: BuildManifestParams): Promise<Manifest> {
  const { serial, response, codeLocatorPathHint } = params;
  const historyDir = params.defaultHistoryDir ?? DEFAULT_HISTORY_DIR;
  const addresses = Array.isArray(response.data) ? response.data : [];

  let codeLocatorPath = codeLocatorPathHint;
  if (!codeLocatorPath) {
    codeLocatorPath = await findLatestCodeLocatorFile(historyDir);
  }

  let resolved: ResolvedView[] | null = null;
  let resolveSource: string | null = null;
  let resolveError: string | null = null;
  if (codeLocatorPath && addresses.length > 0) {
    try {
      const app = await parseCodeLocatorApplication(codeLocatorPath);
      resolved = resolveAddresses(app, addresses);
      resolveSource = codeLocatorPath;
    } catch (err) {
      resolveError = err instanceof Error ? err.message : String(err);
    }
  }

  const hints: string[] = [];
  if (addresses.length === 0) {
    hints.push("TouchViewResponse.data 为空：请在设备上点击你想追踪的位置，然后立刻重跑 find-click。");
  } else if (!codeLocatorPath) {
    hints.push("未发现 ~/.codeLocator_main/historyFile/*.codeLocator，只输出 addresses。先用 grab 抓一帧可反查 className/idStr/bounds。");
  } else if (resolved && resolved.every((r) => r.className === null)) {
    hints.push("memAddr 一个都没匹配上 grab 文件，可能进程已重启（identityHashCode 失效）。请重新 grab 再跑。");
  }

  return {
    status: "ok",
    device: { serial },
    response: { code: response.code ?? 0, msg: response.msg ?? null, addressCount: addresses.length },
    addresses,
    resolveSource,
    resolveError,
    resolved,
    hints,
  };
}

/** DI 接口：测试可注入 stub，避免真机 adb 调用。 */
export interface FindClickDeps {
  pickDevice: (explicit: string | null) => Promise<string>;
  fetchTouchViewResponse: (serial: string) => Promise<TouchViewResponse>;
  defaultHistoryDir?: string;
}

export const defaultDeps: FindClickDeps = {
  pickDevice: defaultPickDevice,
  fetchTouchViewResponse,
};

/** 端到端编排：device pick → broadcast → manifest。e2e 用默认 deps，unit 用 stub。 */
export async function runFindClick(opts: CliOptions, deps: FindClickDeps = defaultDeps): Promise<Manifest> {
  const serial = await deps.pickDevice(opts.serial);
  const response = await deps.fetchTouchViewResponse(serial);
  return await buildManifest({
    serial,
    response,
    codeLocatorPathHint: opts.codeLocatorPath,
    defaultHistoryDir: deps.defaultHistoryDir,
  });
}

// ============================================================
// CLI 入口：仅当本文件被直接执行时跑，避免 import 时副作用。
// ============================================================

function isCliEntry(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("find-click.ts") || entry.endsWith("find-click.js");
}

async function cliMain(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = await runFindClick(opts);
  console.log(JSON.stringify(manifest, null, opts.pretty ? 2 : 0));
}

if (isCliEntry()) {
  cliMain().catch((err: unknown) => {
    if (err instanceof SilentExit) {
      console.log(usage());
      return;
    }
    const pretty = process.argv.includes("--pretty");
    const body: Record<string, unknown> = { status: "error" };
    if (err instanceof DeviceSelectError) {
      body.code = err.code;
      body.message = err.message;
      body.candidates = err.candidates;
    } else {
      body.code = "FIND_CLICK_FAILED";
      body.message = err instanceof Error ? err.message : String(err);
    }
    console.log(JSON.stringify(body, null, pretty ? 2 : 0));
    process.exitCode = 1;
  });
}
