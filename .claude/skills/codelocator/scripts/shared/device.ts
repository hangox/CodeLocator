// shared/device.ts
// device picker：
//  - 显式 serial → 直接用
//  - 无 serial 且只有 1 台设备 → 自动选
//  - 无 serial 且 0 台 → 抛错
//  - 无 serial 且 ≥2 台 → 抛错并列出 serial 供 CLI 提示用户
//
// 为什么不交互式选：这些脚本设计为 AI agent 的工具调用，不应阻塞 stdin。
// 多设备场景由调用方（cli.ts）通过 --device <serial> 显式指定。

import { listDevices, type AdbRunOptions } from "./adb.ts";

export class DeviceSelectError extends Error {
  readonly code: "NO_DEVICE" | "MULTIPLE_DEVICES";
  readonly candidates: string[];

  constructor(code: "NO_DEVICE" | "MULTIPLE_DEVICES", message: string, candidates: string[]) {
    super(message);
    this.name = "DeviceSelectError";
    this.code = code;
    this.candidates = candidates;
  }
}

/**
 * 选择一台 adb 设备 serial。
 * @param explicit 用户显式指定的 serial（CLI --device 透传）；为 null 时走自动选择逻辑。
 * @param opts     透传给底层 listDevices 的 adb 选项（adbPath / timeoutMs）。
 * @returns 已选中的 serial 字符串。
 */
export async function pickDevice(explicit: string | null, opts?: AdbRunOptions): Promise<string> {
  // serial 不能由本函数自己来填——调用方传什么就用什么；opts.serial 在 listDevices 上下文里没意义，忽略即可。
  const probeOpts = opts ? { adbPath: opts.adbPath, timeoutMs: opts.timeoutMs } : undefined;

  if (explicit) {
    // 校验 explicit 是否真的在线，避免后续每个 adb 调用都报错。
    const online = await listDevices(probeOpts);
    if (!online.includes(explicit)) {
      throw new DeviceSelectError(
        "NO_DEVICE",
        `指定的设备 serial=${explicit} 不在 adb devices 列表中`,
        online,
      );
    }
    return explicit;
  }

  const online = await listDevices(probeOpts);
  if (online.length === 0) {
    throw new DeviceSelectError("NO_DEVICE", "未发现已连接的 adb 设备", online);
  }
  if (online.length === 1) {
    return online[0];
  }
  throw new DeviceSelectError(
    "MULTIPLE_DEVICES",
    `检测到多台设备，请用 --device <serial> 指定: ${online.join(", ")}`,
    online,
  );
}
