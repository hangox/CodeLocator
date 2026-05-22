// shared/codec.ts
// CodeLocator 协议编解码：
//  - encode: {key: value, ...} → JSON → Base64(URL-SAFE, no padding) → '--es codeLocator_shell_args xxx'
//  - decode: am broadcast stdout → 提取 data="..." 或 FP:<path>
//
// 为什么独立成模块：grab / schema / find-click 都要走同一套协议；放 shared 避免散落。
//
// ⚠ Base64 编码必须用 URL-SAFE（no padding、no wrap），对齐 SDK 端 SmartArgs.decodeToString → Base64.java URL_SAFE 解码表。
//   插件 BroadcastAction.java 调 Base64.encodeToString(json)（1-arg）走 DEFAULT_FLAGS = URL_SAFE | NO_PADDING | NO_WRAP；
//   设备端 Base64 解码器对 "+" / "/" 直接 return false → args=null → SDK 静默无响应。
//   不要改回标准 base64。Node 16+ 用 `.toString("base64url")` 即可正确对齐。
//
// 协议事实见 docs/03 §1.2、CodeLocatorPlugin BroadcastAction.buildCmd 与 CodeLocatorModel Base64.java。

// @ts-ignore Node 内置 Buffer
import { Buffer } from "node:buffer";

/** Broadcast 参数：Java 侧 HashMap<String, String> 会把所有值 toString，所以这里也统一转 string。 */
export type BroadcastArgs = Record<string, string | number | boolean>;

/** 解析 am broadcast 回执后的三种状态。 */
export type BroadcastResultPayload =
  | { kind: "inline"; data: string }   // result data="<base64(compressed-json)>"，可直接 decompress 后用
  | { kind: "file"; path: string }     // result data="FP:<path>"，需要 adb pull 后再解压
  | { kind: "empty" }                  // 既没 data= 也没 FP:，可能是 async 模式（轮询 Provider）或 SDK 未初始化
  | { kind: "error"; message: string }; // 显式错误码（参考 CodeLocatorConstants.Error）

/**
 * 把 args dict 编码成 broadcast 的 codeLocator_shell_args 值。
 * BroadcastAction.buildCmd 把所有值 toString 后塞 HashMap，再 Gson 序列化为 JSON 串，再 Base64。
 * 这里复刻同样规则。
 *
 * 注意：插件侧在 isAsyncBroadcast() 时会自动注入 KEY_ASYNC=true（见 BroadcastAction.buildCmd L104）；
 * 我们的脚本默认不开 async（grab 单次拉取已经够，async 是 IDE 长连接的场景），所以这里不注入。
 */
export function encodeShellArgs(args: BroadcastArgs): string {
  const stringified: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    stringified[k] = String(v);
  }
  const json = JSON.stringify(stringified);
  // 必须 URL-SAFE：插件端 BroadcastAction.java 用 Base64.encodeToString(json) 走 DEFAULT_FLAGS=URL_SAFE|NO_PADDING|NO_WRAP；
  // 设备 SDK 端 SmartArgs.decodeToString 同样走 URL_SAFE 表，碰到 "+" / "/" 会 return false → args=null → broadcast 静默无响应。
  // base64url 用 "-" "_" 替代 "+" "/"，且默认去 padding，正好对齐。不要改回标准 base64。
  return Buffer.from(json, "utf-8").toString("base64url");
}

/**
 * 反向解码（调试/测试用）。
 * 兼容 URL-SAFE 与标准 base64：Node Buffer 的 "base64" 解码器同时识别 "+/" 和 "-_"。
 */
export function decodeShellArgs(base64: string): Record<string, string> {
  const json = Buffer.from(base64, "base64").toString("utf-8");
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decoded shell args is not a JSON object");
  }
  return parsed as Record<string, string>;
}

/**
 * 解析 `am broadcast` 同步回执 stdout。
 *
 * 典型 stdout 形态（参考 DeviceManager.parserResult L382~ 与 L410~）：
 *   Broadcasting: Intent { act=... }
 *   Broadcast completed: result=-1, data="FP:/sdcard/codeLocator/xxx.txt"
 * 或
 *   Broadcast completed: result=-1, data="eJzNVE1v..."
 * 或（空回执，需要走 async 轮询）：
 *   Broadcast completed: result=0
 *
 * data="FP:" 与 data="<base64>" 的判断：参考 DeviceManager.parserResult 的 `filePathStart` 检测。
 */
export function parseBroadcastResult(stdout: string): BroadcastResultPayload {
  const filePathStart = `data="FP:`;
  const fpStart = stdout.indexOf(filePathStart);
  if (fpStart >= 0) {
    const valueStart = fpStart + filePathStart.length;
    // FP:<path> 一定是 stdout 中最后一个 data="..." 字段，取最后一个引号位置作为结尾。
    const valueEnd = stdout.lastIndexOf('"');
    if (valueEnd > valueStart) {
      const raw = stdout.substring(valueStart, valueEnd);
      return { kind: "file", path: stripControlChars(raw) };
    }
  }

  const dataStart = `data="`;
  const di = stdout.indexOf(dataStart);
  if (di >= 0) {
    const valueStart = di + dataStart.length;
    const valueEnd = stdout.lastIndexOf('"');
    if (valueEnd > valueStart) {
      const raw = stdout.substring(valueStart, valueEnd);
      const cleaned = stripControlChars(raw);
      // TODO: 复核必要性。SDK 端 ErrorResponse 也走 Gson + GZIP + Base64 序列化（CodeLocatorReceiver.sendResult），
      // 不会以明文 "Error:" 出现在 data="..."。保留这个分支只是为了挡住未来某个直接 setResultData 的边角路径，
      // 若 grep 不到具体来源就可以删。
      if (cleaned.startsWith("Error:")) {
        return { kind: "error", message: cleaned.substring("Error:".length) };
      }
      return { kind: "inline", data: cleaned };
    }
  }

  return { kind: "empty" };
}

/**
 * 解析 CodeLocatorProvider content query 输出的某一列值。
 * 形如：`Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=true, AsyncResult=FP:/sdcard/...`
 * 抄 DeviceManager.getResultForAsyncBroadcast 的 StringUtils.getValue 思路。
 */
export function pickProviderField(content: string, key: string): string {
  const start = content.indexOf(`${key}=`);
  if (start < 0) return "";
  const valueStart = start + key.length + 1;
  // 字段以 ", " 或行尾 / 字符串结尾分隔。
  const remainder = content.substring(valueStart);
  const sepIdx = remainder.indexOf(",");
  return (sepIdx >= 0 ? remainder.substring(0, sepIdx) : remainder).trim();
}

function stripControlChars(s: string): string {
  return s
    .replace(/\n/gu, "")
    .replace(/\b/gu, "")
    .replace(/\r/gu, "")
    .replace(/\f/gu, "")
    .replace(/\t/gu, "")
    .trim();
}
