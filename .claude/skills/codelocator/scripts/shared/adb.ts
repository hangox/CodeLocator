// shared/adb.ts
// adb 命令封装：device 选择、shell 执行、broadcast 调用、文件 pull
// 设计原则：薄包装，调用方传 deviceSerial（可空），由本模块决定是否加 `-s <serial>`。
// 为什么不依赖第三方 SDK：保持纯 Node + child_process，避免 npm 安装。

// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { spawn } from "node:child_process";

declare const process: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number };
declare const Buffer: { concat(list: Uint8Array[]): Uint8Array };

/** adb 命令执行结果。stdout/stderr 已 trim。 */
export interface AdbResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** adb shell 一次性命令的执行选项。 */
export interface AdbRunOptions {
  /** 目标设备 serial；空表示由 adb 默认逻辑选择（仅一台设备时合法）。 */
  readonly serial?: string | null;
  /** 命令超时毫秒；默认 30_000。 */
  readonly timeoutMs?: number;
  /** 自定义 adb 二进制路径；默认 `adb`。可通过 env ADB_PATH 覆盖。 */
  readonly adbPath?: string;
}

/** adb shell broadcast 的参数对象（值统一转字符串后序列化）。 */
export type BroadcastArgs = Record<string, string | number | boolean>;

/** broadcast 调用结果。raw 是 am broadcast 原始 stdout，便于上层 codec 解析 `data="..."` 或 `FP:`。 */
export interface BroadcastResult extends AdbResult {
  /** 原始 broadcast stdout，等同于 result.stdout，但显式命名提示用法。 */
  readonly raw: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function adbBin(opts?: AdbRunOptions): string {
  return opts?.adbPath ?? process.env.ADB_PATH ?? "adb";
}

function prefixWithSerial(serial: string | null | undefined, args: string[]): string[] {
  return serial ? ["-s", serial, ...args] : args;
}

async function runProcess(bin: string, args: string[], timeoutMs: number): Promise<AdbResult> {
  return await new Promise<AdbResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`adb command timed out after ${timeoutMs}ms: ${bin} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Uint8Array) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => stderrChunks.push(chunk));
    child.on("error", (err: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const stdout = new TextDecoder().decode(Buffer.concat(stdoutChunks)).trim();
      const stderr = new TextDecoder().decode(Buffer.concat(stderrChunks)).trim();
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 列出当前 adb 已连接的设备（state=device）。
 * 手测：`adb devices` → 应与本函数返回的 serial 列表一致。
 */
export async function listDevices(opts?: AdbRunOptions): Promise<string[]> {
  const result = await runProcess(adbBin(opts), ["devices"], opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(`adb devices failed (code=${result.code}): ${result.stderr || result.stdout}`);
  }
  // 跳过首行 "List of devices attached"
  const lines = result.stdout.split(/\r?\n/).slice(1);
  const serials: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (state === "device" && serial) serials.push(serial);
  }
  return serials;
}

/**
 * 执行 `adb shell <cmd>`。cmd 由调用方组装好（含所有 shell escape）。
 * 手测：`adb shell echo hi` → stdout 应包含 "hi"。
 */
export async function shell(cmd: string, opts?: AdbRunOptions): Promise<AdbResult> {
  const args = prefixWithSerial(opts?.serial, ["shell", cmd]);
  return await runProcess(adbBin(opts), args, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/**
 * 执行 `adb shell am broadcast -a <action> --es codeLocator_shell_args '<base64>'`。
 * codec 模块负责把 args → base64；这里只拼最终 shell 命令并跑。
 * 手测：连一台集成 SDK 的 App，调 broadcast(ACTION_DEBUG_LAYOUT_INFO, {}) → result.raw 应包含 `data="..."` 或 `FP:`。
 */
export async function broadcast(action: string, encodedArgs: string | null, opts?: AdbRunOptions): Promise<BroadcastResult> {
  // 为什么用单引号包 encodedArgs：base64 末尾可能有 = 号，且 JSON 含 {} : 等，shell 转义最稳的方式。
  let cmd = `am broadcast -a ${action}`;
  if (encodedArgs) {
    cmd += ` --es codeLocator_shell_args '${encodedArgs}'`;
  }
  const result = await shell(cmd, opts);
  return { ...result, raw: result.stdout };
}

/**
 * 执行 `adb pull <remote> <local>`。
 * 手测：`adb pull /sdcard/codeLocator/foo.txt /tmp/foo.txt` → 本地 /tmp/foo.txt 应出现。
 */
export async function pull(remote: string, local: string, opts?: AdbRunOptions): Promise<AdbResult> {
  const args = prefixWithSerial(opts?.serial, ["pull", remote, local]);
  return await runProcess(adbBin(opts), args, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/**
 * 查询 Android API level（`getprop ro.build.version.sdk`）。
 * grab 流程需要它来决定设备侧落盘路径（≥30 走 /sdcard/codeLocator，<30 走 ExternalCacheDir）。
 */
export async function getApiLevel(opts?: AdbRunOptions): Promise<number> {
  const result = await shell("getprop ro.build.version.sdk", opts);
  if (result.code !== 0) {
    throw new Error(`getprop failed: ${result.stderr || result.stdout}`);
  }
  const level = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(level)) {
    throw new Error(`unexpected ro.build.version.sdk: "${result.stdout}"`);
  }
  return level;
}

/**
 * 查询当前 resumed activity。
 * 返回 "pkg/.Activity" 形态字符串，找不到则返回 null。
 * grab 前调用，确认目标 App 在前台。
 *
 * 兼容性：
 *   - Android 12 及更早：dumpsys 输出 `mResumedActivity: ActivityRecord{...}`
 *   - Android 13+：改成 `topResumedActivity=ActivityRecord{...}`
 * 用 egrep 同时匹配两种字段名，避免新机型上误判"无前台 Activity"。
 */
export async function getResumedActivity(opts?: AdbRunOptions): Promise<string | null> {
  const result = await shell(
    "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'",
    opts,
  );
  if (result.code !== 0 || !result.stdout) return null;
  // 典型行（两种形态）：
  //   `  mResumedActivity: ActivityRecord{... u0 com.foo/.MainActivity t123}`
  //   `    topResumedActivity=ActivityRecord{... u0 com.foo/.MainActivity t123}`
  const match = result.stdout.match(/u\d+\s+([\w.]+\/[\w.$]+)/u);
  return match ? match[1] : null;
}
