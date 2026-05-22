// scripts/schema.ts
// Send Schema：先用系统 `am start -d` 路由 deep link；失败再走 SDK broadcast fallback。
// 协议依据：docs/03 §4.5（ACTION_PROCESS_SCHEMA / KEY_SCHEMA）、docs/08 §5 MVP #2。
// 为什么有 fallback：部分 schema 未在 AndroidManifest 暴露 intent-filter，但 App 内
//   通过 CodeLocator SDK 注册了 schema 路由，这时只能让 SDK 进程内部 startActivity。

import { broadcast, shell } from "./shared/adb.ts";
import { encodeShellArgs, parseBroadcastResult, type BroadcastResultPayload } from "./shared/codec.ts";
import { DeviceSelectError, pickDevice } from "./shared/device.ts";

declare const process: { argv: string[]; exitCode?: number };

/** 常量来自 CodeLocatorApp/.../CodeLocatorConstants.java（见 docs/03 §2.2 / §2.3）。 */
const ACTION_PROCESS_SCHEMA = "com.bytedance.tools.codelocator.action_process_schema";
const KEY_SCHEMA = "codeLocator_schema";
const KEY_SAVE_TO_FILE = "codeLocator_save_to_file";

export interface SchemaOptions {
  readonly url: string;
  readonly device?: string | null;
  /** 默认 true：am start 路由失败时再走 broadcast fallback。 */
  readonly fallback?: boolean;
  /** 透传到 fallback broadcast 的 KEY_SAVE_TO_FILE；普通 schema 不需要。 */
  readonly saveToFile?: boolean;
}

export interface SchemaResult {
  readonly device: string;
  readonly primary: { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
  readonly fallback?: {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly payload: BroadcastResultPayload;
  };
}

/**
 * `am start` 退出码 0 但 stdout/stderr 出现 `Error:` 行时视为失败。
 *
 * 关键区分：am 在目标 Activity 已是 top-most 时打印
 *   `Warning: Activity not started, intent has been delivered to currently running top-most instance.`
 * 这是成功（intent 已经投递），不能因为含 "Activity not started" 就判失败。
 * 真失败永远以 `Error:` 开头，例如 `Error: Activity not started, unable to resolve Intent`。
 */
function amStartSucceeded(stdout: string, stderr: string, code: number): boolean {
  if (code !== 0) return false;
  return !/(^|\n)\s*Error:/i.test(`${stdout}\n${stderr}`);
}

export async function runSchema(opts: SchemaOptions): Promise<SchemaResult> {
  const device = await pickDevice(opts.device ?? null);

  // shell 命令里用单引号包裹 schema：& ? = 等元字符不会被本机 shell 再解释一遍。
  // 极少数 schema 自带单引号时按 POSIX 拆分转义。
  const quoted = `'${opts.url.replace(/'/g, `'\\''`)}'`;
  const primary = await shell(`am start -d ${quoted}`, { serial: device });
  const primaryOk = amStartSucceeded(primary.stdout, primary.stderr, primary.code);

  if (primaryOk || opts.fallback === false) {
    return {
      device,
      primary: { ok: primaryOk, stdout: primary.stdout, stderr: primary.stderr },
    };
  }

  const args: Record<string, string | boolean> = { [KEY_SCHEMA]: opts.url };
  if (opts.saveToFile) args[KEY_SAVE_TO_FILE] = true;
  const bc = await broadcast(ACTION_PROCESS_SCHEMA, encodeShellArgs(args), { serial: device });

  return {
    device,
    primary: { ok: primaryOk, stdout: primary.stdout, stderr: primary.stderr },
    fallback: {
      ok: bc.code === 0,
      stdout: bc.stdout,
      stderr: bc.stderr,
      payload: parseBroadcastResult(bc.raw),
    },
  };
}

// ---------- CLI ----------

interface ParsedCli {
  url?: string;
  device: string | null;
  fallback: boolean;
  saveToFile: boolean;
  help: boolean;
}

function parseArgv(argv: string[]): ParsedCli {
  const out: ParsedCli = { device: null, fallback: true, saveToFile: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--device" || a === "-s") out.device = argv[++i] ?? null;
    else if (a.startsWith("--device=")) out.device = a.slice("--device=".length);
    else if (a === "--schema") out.url = argv[++i];
    else if (a.startsWith("--schema=")) out.url = a.slice("--schema=".length);
    else if (a === "--no-fallback") out.fallback = false;
    else if (a === "--save-to-file") out.saveToFile = true;
    else if (!a.startsWith("-") && out.url === undefined) out.url = a;
  }
  return out;
}

function usage(): string {
  return [
    "用法: node schema.ts <url> [--device <serial>] [--no-fallback] [--save-to-file]",
    "",
    "示例:",
    "  node schema.ts 'snssdk1128://feed?tab_id=1'",
    "  node schema.ts --schema 'aweme://discover' --device emulator-5554",
    "",
    "流程：先 am start -d；失败时回落到 ACTION_PROCESS_SCHEMA broadcast。",
  ].join("\n");
}

export async function runSchemaCli(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  if (!parsed.url) {
    console.log(usage());
    return 1;
  }
  try {
    const result = await runSchema({
      url: parsed.url,
      device: parsed.device,
      fallback: parsed.fallback,
      saveToFile: parsed.saveToFile,
    });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof DeviceSelectError ? err.code : "ERROR";
    const candidates = err instanceof DeviceSelectError ? err.candidates : undefined;
    console.log(JSON.stringify({ status: "error", code, message, candidates }, null, 2));
    return 1;
  }
}

// 直接 `node schema.ts ...` 时跑 CLI；被 cli.ts import 时不触发。
// 用 endsWith 兼容 strip-types 模式下 import.meta.url 形如 file:///.../schema.ts。
const entry = process.argv[1] ?? "";
if (import.meta.url.endsWith("/schema.ts") && entry.endsWith("/schema.ts")) {
  runSchemaCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
