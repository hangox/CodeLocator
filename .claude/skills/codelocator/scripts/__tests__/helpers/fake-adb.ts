// 测试用：在 tmpdir 里生成一份"假 adb"可执行 Node 脚本，按预设规则吐 stdout/stderr 和 exit code。
// 通过把它的路径喂给 AdbRunOptions.adbPath，可以在不依赖真 adb 的情况下覆盖整条 shell/broadcast/pull/listDevices 路径。
//
// 设计：fake-adb 把每次调用的 argv 写到 INVOCATIONS_LOG 文件里，方便测试断言"实际跑出了什么命令"。

// @ts-ignore Node 内置
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
// @ts-ignore Node 内置
import { tmpdir } from "node:os";
// @ts-ignore Node 内置
import { join } from "node:path";

export interface FakeAdbResponse {
  /** 命令行匹配规则：argv.join(" ") 是否 startsWith 这个 prefix。第一个匹配的优先。 */
  readonly match: string;
  /** 该规则下要吐出的 stdout 文本。 */
  readonly stdout?: string;
  /** stderr 文本。 */
  readonly stderr?: string;
  /** 退出码，默认 0。 */
  readonly exitCode?: number;
}

export interface FakeAdb {
  /** 喂给 AdbRunOptions.adbPath。 */
  readonly path: string;
  /** 调用日志：每行一条 JSON {argv, cwd}。 */
  readonly invocationsLogPath: string;
  /** 读出所有调用（argv 数组）。 */
  readInvocations(): string[][];
  /** 删除临时目录。 */
  cleanup(): void;
}

/**
 * 生成一份带规则表的 fake adb。
 *
 * 例：
 *   const adb = makeFakeAdb([
 *     { match: "devices", stdout: "List of devices attached\nXYZ\tdevice\n" },
 *     { match: "shell echo hi", stdout: "hi" },
 *   ]);
 *   try {
 *     const serials = await listDevices({ adbPath: adb.path });
 *     // ...
 *   } finally { adb.cleanup(); }
 */
export function makeFakeAdb(responses: FakeAdbResponse[]): FakeAdb {
  const dir = mkdtempSync(join(tmpdir(), "codelocator-fakeadb-"));
  const logPath = join(dir, "invocations.log");
  const scriptPath = join(dir, "adb");
  const rulesPath = join(dir, "rules.json");

  writeFileSync(rulesPath, JSON.stringify(responses));

  // 注：fake adb 用 Node 脚本而不是 shell 脚本，避免 macOS / linux 行为差异。
  // 通过 shebang 把自己当成可执行文件，但 spawn(fakeAdb, [...args]) 也能直接由 Node 调起来。
  // 为了保持"不要 npm init"的约束，shebang 用绝对路径指向当前运行的 node。
  const nodePath = process.execPath;
  const script = `#!${nodePath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(rulesPath)}, "utf-8"));
const joined = argv.join(" ");
for (const r of rules) {
  if (joined.startsWith(r.match)) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode == null ? 0 : r.exitCode);
  }
}
process.stderr.write("fake-adb: no rule matched for: " + joined + "\\n");
process.exit(127);
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);

  return {
    path: scriptPath,
    invocationsLogPath: logPath,
    readInvocations(): string[][] {
      if (!existsSync(logPath)) return [];
      const content = readFileSync(logPath, "utf-8");
      return content
        .split("\n")
        .filter((line: string) => line.trim() !== "")
        .map((line: string) => (JSON.parse(line) as { argv: string[] }).argv);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

declare const process: { argv: string[]; execPath: string };
