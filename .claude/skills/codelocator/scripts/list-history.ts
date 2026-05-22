#!/usr/bin/env node

// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { access, readdir, stat } from "node:fs/promises";
// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { join, resolve } from "node:path";
// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { homedir } from "node:os";

declare const process: { argv: string[]; exitCode?: number };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type CliOptions = {
  historyDir: string;
  packageFilter: string | null;
  limit: number;
  pretty: boolean;
};

type HistoryItem = {
  path: string;
  filename: string;
  package: string | null;
  grabTime: string | null;
  grabTimeMs: number | null;
  sizeBytes: number;
  mtimeMs: number;
};

class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function stringifyStdout(value: JsonObject, pretty: boolean): string {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

function printJson(value: JsonObject, pretty: boolean): void {
  console.log(stringifyStdout(value, pretty));
}

function prettyRequestedFromArgv(args: string[]): boolean {
  return args.includes("--pretty");
}

function errorCodeOf(error: unknown): string {
  if (error instanceof CliError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name || "UNKNOWN_ERROR";
  }
  return "UNKNOWN_ERROR";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultHistoryDir(): string {
  return join(homedir(), ".codeLocator_main", "historyFile");
}

function parseLimit(raw: string): number {
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new CliError("INVALID_LIMIT", `--limit 必须是正整数: ${raw}`);
  }
  return limit;
}

function parseCliArgs(args: string[]): CliOptions {
  let historyDir = defaultHistoryDir();
  let packageFilter: string | null = null;
  let limit = 50;
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--dir") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_DIR", "--dir 缺少目录参数");
      }
      historyDir = resolve(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      historyDir = resolve(arg.slice("--dir=".length));
      continue;
    }
    if (arg === "--package") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_PACKAGE", "--package 缺少包名参数");
      }
      packageFilter = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--package=")) {
      packageFilter = arg.slice("--package=".length);
      continue;
    }
    if (arg === "--limit") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_LIMIT", "--limit 缺少数值参数");
      }
      limit = parseLimit(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }
    throw new CliError("UNKNOWN_OPTION", `未知参数: ${arg}`);
  }

  return {
    historyDir,
    packageFilter,
    limit,
    pretty,
  };
}

function parseHistoryFilename(filename: string): Pick<HistoryItem, "package" | "grabTime" | "grabTimeMs"> {
  const match = filename.match(/^(.*)(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.codeLocator$/u);
  if (!match) {
    return {
      package: null,
      grabTime: null,
      grabTimeMs: null,
    };
  }

  const [, packageName, year, month, day, hour, minute, second] = match;
  const grabTime = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const grabDate = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  );
  const grabTimeMs = Number.isNaN(grabDate.getTime()) ? null : grabDate.getTime();

  return {
    package: packageName || null,
    grabTime,
    grabTimeMs,
  };
}

function historyItemComparator(left: HistoryItem, right: HistoryItem): number {
  if (left.grabTimeMs !== null && right.grabTimeMs !== null) {
    return right.grabTimeMs - left.grabTimeMs;
  }
  if (left.grabTimeMs !== null) {
    return -1;
  }
  if (right.grabTimeMs !== null) {
    return 1;
  }
  return right.mtimeMs - left.mtimeMs;
}

function buildManifest(historyDir: string, scanned: number, returnedItems: HistoryItem[], packageFilter: string | null, limit: number): JsonObject {
  const totalSizeBytes = returnedItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  return {
    status: "ok",
    stats: {
      historyDir,
      scanned,
      returned: returnedItems.length,
      totalSizeBytes,
      filters: {
        package: packageFilter,
        limit,
      },
    },
    items: returnedItems.map((item) => ({
      path: item.path,
      filename: item.filename,
      package: item.package,
      grabTime: item.grabTime,
      grabTimeMs: item.grabTimeMs,
      sizeBytes: item.sizeBytes,
      mtimeMs: item.mtimeMs,
    })),
    next_steps: [
      "Pick items[].path and call scripts/parse-codelocator-file.ts <path> <output-dir> [--src <android-project-root>]",
      "Filter by --package <pkg> to narrow down when too many results",
      "Use --limit N to cap output",
    ],
  };
}

async function ensureDirExists(historyDir: string): Promise<void> {
  try {
    await access(historyDir);
  } catch {
    throw new CliError("HISTORY_DIR_NOT_FOUND", `历史目录不存在: ${historyDir}`);
  }
}

async function readHistoryItems(historyDir: string): Promise<HistoryItem[]> {
  const entries = await readdir(historyDir, { withFileTypes: true });
  const items: HistoryItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".codeLocator")) {
      continue;
    }
    const filePath = join(historyDir, entry.name);
    const fileStat = await stat(filePath);
    const parsed = parseHistoryFilename(entry.name);
    items.push({
      path: filePath,
      filename: entry.name,
      package: parsed.package,
      grabTime: parsed.grabTime,
      grabTimeMs: parsed.grabTimeMs,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    });
  }

  return items;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  await ensureDirExists(options.historyDir);

  const scannedItems = await readHistoryItems(options.historyDir);
  const packageFilter = options.packageFilter;
  const filteredItems = packageFilter
    ? scannedItems.filter((item) => item.package !== null && item.package.startsWith(packageFilter))
    : scannedItems;
  const returnedItems = [...filteredItems]
    .sort(historyItemComparator)
    .slice(0, options.limit);

  printJson(buildManifest(options.historyDir, scannedItems.length, returnedItems, options.packageFilter, options.limit), options.pretty);
}

main().catch((error: unknown) => {
  const pretty = prettyRequestedFromArgv(process.argv.slice(2));
  printJson({
    status: "error",
    error: {
      code: errorCodeOf(error),
      message: errorMessageOf(error),
    },
  }, pretty);
  process.exitCode = 1;
});
