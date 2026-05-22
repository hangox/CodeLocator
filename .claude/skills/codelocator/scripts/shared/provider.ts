// shared/provider.ts
// CodeLocatorProvider 健康检查与轮询封装。
//
// 设备侧 ContentProvider 由 SDK 注册：authority = "<pkg>.CodeLocatorProvider"
// 三列：CodeLocatorVersion / AsyncBroadcast / AsyncResult（CodeLocatorProvider.java L33）
//
// 用途：
//  1) grab/find-click 之前先 ping 一下，确认 App 集成了 SDK
//  2) async 模式下轮询 AsyncResult 拿到 FP:<path>
//
// 注：本 skill 默认走同步 broadcast，async 轮询暂时只做接口；MVP 阶段 grab.ts 不强依赖。

import { shell, type AdbRunOptions } from "./adb.ts";
import { pickProviderField } from "./codec.ts";

export interface ProviderHealth {
  readonly available: boolean;
  /** SDK BuildConfig.VERSION_NAME，如 "2.1.0"。available=false 时为 null。 */
  readonly version: string | null;
  /** 是否启用 AsyncBroadcast。 */
  readonly asyncBroadcast: boolean;
  /** 当前缓存的 async 结果（多半是 FP:<path>，可能空）。 */
  readonly asyncResult: string;
  /** content query 原始输出，便于排错。 */
  readonly raw: string;
}

/**
 * 查询 `content://<pkg>.CodeLocatorProvider` 并解析三列。
 * 输出示例：
 *   Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=true, AsyncResult=
 *   Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=true, AsyncResult=FP:/sdcard/codeLocator/xxx.txt
 * 若 App 未集成 SDK：stdout 会含 "Error"（DeviceManager.getApplicationWhenBroadcastEmpty 用 toLowerCase().contains("error") 判定）。
 *
 * 手测：`adb shell content query --uri content://com.foo.bar.CodeLocatorProvider`
 */
export async function probeProvider(packageName: string, opts?: AdbRunOptions): Promise<ProviderHealth> {
  const authority = `${packageName}.CodeLocatorProvider`;
  const result = await shell(`content query --uri content://${authority}`, opts);
  const raw = result.stdout || "";

  // 必要条件：stdout 含 "Row:"（MatrixCursor 输出标志）。这是判定 Provider 是否真存在的唯一可靠信号。
  // 不再用宽泛的 .includes("error") —— 某些机型 dumpsys 调试串里出现 "error" 字样会误伤。
  // 兜底：明确的 "no provider" / adb 经典 "Can't find provider" 提示，stdout 或 stderr 任一出现即视为不可用。
  if (!raw.includes("Row:")) {
    return {
      available: false,
      version: null,
      asyncBroadcast: false,
      asyncResult: "",
      raw: raw || result.stderr,
    };
  }

  const version = pickProviderField(raw, "CodeLocatorVersion") || null;
  const asyncBroadcastRaw = pickProviderField(raw, "AsyncBroadcast");
  const asyncResult = pickProviderField(raw, "AsyncResult");

  return {
    available: true,
    version,
    asyncBroadcast: asyncBroadcastRaw === "true",
    asyncResult,
    raw,
  };
}

/**
 * async 模式：每 500ms 轮询 Provider，直到 AsyncResult 以 FP: 开头或超过 maxTries 次。
 * 对应 DeviceManager.getResultForAsyncBroadcast 的循环。
 * 返回 FP: 后的设备端路径，未拿到则返回 null。
 */
export async function pollAsyncResult(
  packageName: string,
  maxTries: number,
  opts?: AdbRunOptions,
): Promise<string | null> {
  for (let i = 0; i < maxTries; i += 1) {
    const health = await probeProvider(packageName, opts);
    if (!health.available) return null;
    if (health.asyncResult.startsWith("FP:")) {
      return health.asyncResult.substring("FP:".length).trim();
    }
    await sleep(500);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
