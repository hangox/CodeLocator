#!/usr/bin/env -S node --experimental-strip-types
// scripts/cli.ts
// CodeLocator skill 统一入口：
//
//   读侧：
//     node cli.ts list-history [...]
//     node cli.ts parse [...]
//     node cli.ts measure-distance [...]
//
//   反向：
//     node cli.ts grab [...]
//     node cli.ts schema [...]
//     node cli.ts find-click [...]
//
// 为什么不用 commander：本 skill 设计上不引入 npm 依赖；纯 argv 分发足够，且让子命令 help 由各自实现负责。
//
// 路由策略：直接 spawn `node --experimental-strip-types ./<sub>.ts ...rest`。
// 这样子命令既能独立跑（保留向后兼容），又能从 cli.ts 入口跑，行为一致。

// @ts-ignore Node 内置
import { spawn } from "node:child_process";
// @ts-ignore Node 内置
import { fileURLToPath } from "node:url";
// @ts-ignore Node 内置
import { dirname, join } from "node:path";

declare const process: { argv: string[]; execPath: string; exit(code?: number): never };

const ROUTES: Record<string, string> = {
  // 读侧：解析既有 .codeLocator / 历史文件，不依赖 adb
  "list-history": "list-history.ts",
  parse: "parse-codelocator-file.ts",
  "measure-distance": "measure-distance.ts",
  // 反向：通过 adb 驱动设备 SDK 实时操作
  grab: "grab.ts",
  schema: "schema.ts",
  "find-click": "find-click.ts",
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function topHelp(): string {
  return `Usage: node cli.ts <command> [options]

读侧命令（解析既有抓取文件，不需要 adb）：
  list-history       列出 ~/.codeLocator_main/historyFile/ 下的历史抓取文件
  parse              解析 .codeLocator 文件 → summary / normalized / screenshot
  measure-distance   测量 view 间距 / 对齐关系

反向命令（通过 adb 驱动设备 SDK）：
  grab               抓取当前前台 App 的布局 + 截图，落盘为 .codeLocator
  schema             通过 SDK 触发 schema / 路由跳转
  find-click         根据坐标定位 View，可选触发 mock click

Run \`node cli.ts <command> --help\` 查看子命令参数。
`;
}

function printErr(msg: string): void {
  console.error(msg);
}

function dispatch(): never {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(topHelp());
    process.exit(0);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  const scriptName = ROUTES[sub];
  if (!scriptName) {
    printErr(`未知子命令: ${sub}`);
    printErr(topHelp());
    process.exit(2);
  }

  const scriptPath = join(SCRIPT_DIR, scriptName);
  // 用同一个 node 二进制 + strip-types，避免环境差异。
  const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath, ...rest], {
    stdio: "inherit",
  });
  child.on("close", (code: number | null) => process.exit(code ?? 1));
  child.on("error", (err: Error) => {
    printErr(`无法启动子命令 ${sub}: ${err.message}`);
    process.exit(1);
  });
  // 不会到这；spawn 是异步的，但 dispatch 的返回值由 child handler 接管。
  // never 类型 + 永不到达的 return 让 TS 满意。
  return undefined as never;
}

dispatch();
