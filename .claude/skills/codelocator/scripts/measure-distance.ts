#!/usr/bin/env node

// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { access, readFile } from "node:fs/promises";
// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { resolve } from "node:path";

declare const process: { argv: string[]; exitCode?: number };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type SelectorPredicate = { key: string; value: string };

type CliOptions = {
  inputPath: string;
  rawA: string;
  rawB: string;
  selectorA: SelectorPredicate[];
  selectorB: SelectorPredicate[];
  useDraw: boolean;
  tolerance: number;
  pretty: boolean;
  markdown: boolean;
};

type Rect = { left: number; top: number; right: number; bottom: number };

type ViewRecord = {
  path: string;
  memAddr: string | null;
  idStr: string | null;
  className: string | null;
  text: string | null;
  bounds: Rect | null;
  drawBounds: Rect | null;
};

const ALLOWED_SELECTOR_KEYS = new Set(["path", "id", "idstr", "text", "mem", "class", "index"]);

class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
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

function stringifyStdout(value: JsonObject, pretty: boolean): string {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

function printJson(value: JsonObject, pretty: boolean): void {
  console.log(stringifyStdout(value, pretty));
}

function prettyRequestedFromArgv(args: string[]): boolean {
  return args.includes("--pretty");
}

function usage(): string {
  return [
    "用法:",
    "  node measure-distance.ts <file.normalized.json> --a <selector> --b <selector> [--use draw|bounds] [--tol 1] [--md] [--pretty]",
    "",
    "selector 格式（多条件用 , 连接，AND）：",
    "  path=decorViews/0/2/1",
    "  id=ivAdGame             （后缀匹配 idStr 中的 id 部分）",
    "  idstr=app:ivAdGame      （完全匹配 idStr）",
    "  text=确认按钮",
    "  mem=091ba14e",
    "  class=ImageView         （短类名匹配或全类名后缀）",
    "  index=N                 （消除歧义，在候选里取第 N 个，0-based）",
    "",
    "--use:",
    "  draw   (默认) 使用 drawBounds，屏幕绝对坐标，适合跨容器测距",
    "  bounds 使用 bounds，相对父布局坐标，仅同父子节点之间有意义",
    "",
    "示例:",
    "  node measure-distance.ts foo.normalized.json --a id=btnOk --b id=btnCancel",
    "  node measure-distance.ts foo.normalized.json --a text=确定 --b path=decorViews/0/2 --tol 2 --md",
    "",
    "输出（JSON 到 stdout）：",
    "  - status: ok | not_found | ambiguous | error",
    "  - a / b: 命中的 view 信息（含 bounds / size / center）",
    "  - distance: horizontalGap / verticalGap / centerDx / centerDy / 边到边 / 对齐情况 / relation / 人类可读 summary",
  ].join("\n");
}

function parseTolerance(raw: string): number {
  const tol = Number.parseFloat(raw);
  if (!Number.isFinite(tol) || tol < 0) {
    throw new CliError("INVALID_TOL", `--tol 必须是 ≥ 0 的数: ${raw}`);
  }
  return tol;
}

function parseSelector(raw: string): SelectorPredicate[] {
  const result: SelectorPredicate[] = [];
  for (const piece of raw.split(",")) {
    const text = piece.trim();
    if (!text) {
      continue;
    }
    const eqIndex = text.indexOf("=");
    if (eqIndex <= 0) {
      throw new CliError("INVALID_SELECTOR", `selector 片段缺少 = 号: ${text}`);
    }
    const key = text.slice(0, eqIndex).trim().toLowerCase();
    const value = text.slice(eqIndex + 1).trim();
    if (!ALLOWED_SELECTOR_KEYS.has(key)) {
      throw new CliError("UNKNOWN_SELECTOR_KEY", `不支持的 selector key: ${key}`);
    }
    if (!value) {
      throw new CliError("EMPTY_SELECTOR_VALUE", `selector ${key} 缺少值`);
    }
    result.push({ key, value });
  }
  if (result.length === 0) {
    throw new CliError("EMPTY_SELECTOR", "selector 不能为空");
  }
  return result;
}

function parseCliArgs(args: string[]): CliOptions | undefined {
  if (args.length === 0) {
    return undefined;
  }

  const positionals: string[] = [];
  let rawA: string | undefined;
  let rawB: string | undefined;
  let useDraw = true;
  let tolerance = 1;
  let pretty = false;
  let markdown = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return undefined;
    }
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--md") {
      markdown = true;
      continue;
    }
    if (arg === "--use") {
      const next = args[index + 1];
      if (next !== "bounds" && next !== "draw") {
        throw new CliError("INVALID_USE", "--use 必须是 bounds 或 draw");
      }
      useDraw = next === "draw";
      index += 1;
      continue;
    }
    if (arg.startsWith("--use=")) {
      const value = arg.slice("--use=".length);
      if (value !== "bounds" && value !== "draw") {
        throw new CliError("INVALID_USE", "--use 必须是 bounds 或 draw");
      }
      useDraw = value === "draw";
      continue;
    }
    if (arg === "--tol") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_TOL", "--tol 缺少参数");
      }
      tolerance = parseTolerance(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--tol=")) {
      tolerance = parseTolerance(arg.slice("--tol=".length));
      continue;
    }
    if (arg === "--a") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_A", "--a 缺少 selector");
      }
      rawA = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--a=")) {
      rawA = arg.slice("--a=".length);
      continue;
    }
    if (arg === "--b") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_B", "--b 缺少 selector");
      }
      rawB = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--b=")) {
      rawB = arg.slice("--b=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliError("UNKNOWN_OPTION", `未知参数: ${arg}`);
    }
    positionals.push(arg);
  }

  const [inputArg] = positionals;
  if (!inputArg) {
    return undefined;
  }
  if (!rawA) {
    throw new CliError("MISSING_A", "--a 必填");
  }
  if (!rawB) {
    throw new CliError("MISSING_B", "--b 必填");
  }
  const inputPath = resolve(inputArg);
  if (/\.codeLocator$/iu.test(inputPath)) {
    throw new CliError(
      "RAW_INPUT",
      "请先用 parse-codelocator-file.ts 解析 .codeLocator 文件，再把 *.normalized.json 路径传给本脚本",
    );
  }
  return {
    inputPath,
    rawA,
    rawB,
    selectorA: parseSelector(rawA),
    selectorB: parseSelector(rawB),
    useDraw,
    tolerance,
    pretty,
    markdown,
  };
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function readRect(obj: JsonObject | undefined): Rect | null {
  if (!obj) {
    return null;
  }
  const left = numberValue(obj.left);
  const top = numberValue(obj.top);
  const right = numberValue(obj.right);
  const bottom = numberValue(obj.bottom);
  if (left === null || top === null || right === null || bottom === null) {
    return null;
  }
  return { left, top, right, bottom };
}

function toViewRecord(raw: JsonObject): ViewRecord {
  return {
    path: stringValue(raw.path) ?? "",
    memAddr: stringValue(raw.memAddr),
    idStr: stringValue(raw.idStr),
    className: stringValue(raw.className),
    text: stringValue(raw.text),
    bounds: readRect(objectValue(raw.bounds)),
    drawBounds: readRect(objectValue(raw.drawBounds)),
  };
}

function loadViews(normalized: JsonObject): ViewRecord[] {
  return arrayValue(normalized.flatViews)
    .map((item) => objectValue(item))
    .filter((item): item is JsonObject => item !== undefined)
    .map(toViewRecord);
}

function shortClassName(className: string | null): string {
  if (!className) {
    return "";
  }
  const lastDot = className.lastIndexOf(".");
  return lastDot >= 0 ? className.slice(lastDot + 1) : className;
}

function matchSelector(view: ViewRecord, preds: SelectorPredicate[]): boolean {
  for (const pred of preds) {
    if (pred.key === "index") {
      continue;
    }
    if (!matchSinglePredicate(view, pred)) {
      return false;
    }
  }
  return true;
}

function matchSinglePredicate(view: ViewRecord, pred: SelectorPredicate): boolean {
  const { key, value } = pred;
  switch (key) {
    case "path":
      return view.path === value;
    case "idstr":
      return (view.idStr ?? "") === value;
    case "id": {
      const id = view.idStr ?? "";
      if (!id) {
        return false;
      }
      const colonTail = id.split(":").pop() ?? id;
      const slashTail = id.startsWith("id/") ? id.slice("id/".length) : id;
      return id === value || colonTail === value || slashTail === value;
    }
    case "text":
      return (view.text ?? "") === value;
    case "mem":
      return (view.memAddr ?? "") === value;
    case "class": {
      const cls = view.className ?? "";
      if (!cls) {
        return false;
      }
      return shortClassName(cls) === value || cls === value || cls.endsWith(`.${value}`);
    }
    default:
      return false;
  }
}

function takeIndex(pool: ViewRecord[], preds: SelectorPredicate[]): ViewRecord[] {
  const idxPred = preds.find((p) => p.key === "index");
  if (!idxPred) {
    return pool;
  }
  const n = Number.parseInt(idxPred.value, 10);
  if (!Number.isInteger(n) || n < 0 || n >= pool.length) {
    return [];
  }
  return [pool[n]];
}

function rectFor(view: ViewRecord, useDraw: boolean): Rect | null {
  return useDraw ? view.drawBounds ?? view.bounds : view.bounds ?? view.drawBounds;
}

function toDp(px: number, density: number): number | null {
  if (!Number.isFinite(density) || density <= 0) {
    return null;
  }
  return Math.round(px / density);
}

function round(value: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function computeDistance(a: Rect, b: Rect, tolerance: number, density: number): JsonObject {
  const aCx = (a.left + a.right) / 2;
  const aCy = (a.top + a.bottom) / 2;
  const bCx = (b.left + b.right) / 2;
  const bCy = (b.top + b.bottom) / 2;

  // gap：正数为间距，负数为重叠（重叠量为 -gap）
  const horizontalGap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
  const verticalGap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);

  // 边对边带方向值：正数表示前者在后者左/上侧（即两者间留有该距离）
  const aRightToBLeft = b.left - a.right;
  const bRightToALeft = a.left - b.right;
  const aBottomToBTop = b.top - a.bottom;
  const bBottomToATop = a.top - b.bottom;

  const centerDx = bCx - aCx;
  const centerDy = bCy - aCy;
  const centerDistance = Math.sqrt(centerDx * centerDx + centerDy * centerDy);

  const within = (value: number) => Math.abs(value) <= tolerance;
  const alignment = {
    left: within(a.left - b.left),
    right: within(a.right - b.right),
    top: within(a.top - b.top),
    bottom: within(a.bottom - b.bottom),
    centerX: within(aCx - bCx),
    centerY: within(aCy - bCy),
  };

  const aContainsB = a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
  const bContainsA = b.left <= a.left && b.top <= a.top && b.right >= a.right && b.bottom >= a.bottom;
  let relation: string;
  if (aContainsB && bContainsA) {
    relation = "equal";
  } else if (aContainsB) {
    relation = "contains";
  } else if (bContainsA) {
    relation = "containedBy";
  } else if (horizontalGap < 0 && verticalGap < 0) {
    relation = "intersects";
  } else if (horizontalGap > 0 && verticalGap > 0) {
    relation = "disjoint";
  } else {
    relation = "edgeAligned";
  }

  return {
    horizontalGap,
    verticalGap,
    horizontalGapDp: toDp(horizontalGap, density),
    verticalGapDp: toDp(verticalGap, density),
    centerDx,
    centerDy,
    centerDistance: round(centerDistance, 2),
    edges: {
      aRightToBLeft,
      bRightToALeft,
      aBottomToBTop,
      bBottomToATop,
    },
    alignment,
    relation,
    summary: humanSummary({ horizontalGap, verticalGap, centerDx, centerDy, alignment, relation, density, tolerance }),
  };
}

function humanSummary(args: {
  horizontalGap: number;
  verticalGap: number;
  centerDx: number;
  centerDy: number;
  alignment: { left: boolean; right: boolean; top: boolean; bottom: boolean; centerX: boolean; centerY: boolean };
  relation: string;
  density: number;
  tolerance: number;
}): string {
  const { horizontalGap, verticalGap, centerDx, centerDy, alignment, relation, density, tolerance } = args;
  const parts: string[] = [];

  if (relation === "contains") {
    parts.push("A 完全包含 B");
  } else if (relation === "containedBy") {
    parts.push("A 在 B 内部");
  } else if (relation === "equal") {
    parts.push("A 与 B 边界相同");
  } else {
    const directions: string[] = [];
    if (Math.abs(centerDx) > tolerance) {
      directions.push(centerDx > 0 ? "B 在 A 右侧" : "B 在 A 左侧");
    }
    if (Math.abs(centerDy) > tolerance) {
      directions.push(centerDy > 0 ? "B 在 A 下方" : "B 在 A 上方");
    }
    if (directions.length > 0) {
      parts.push(directions.join(" "));
    }
  }

  const formatPx = (value: number) => (density > 0 ? `${value}px (${toDp(value, density)}dp)` : `${value}px`);
  if (horizontalGap > 0) {
    parts.push(`水平间距 ${formatPx(horizontalGap)}`);
  } else if (horizontalGap < 0) {
    parts.push(`水平重叠 ${formatPx(-horizontalGap)}`);
  } else {
    parts.push("水平贴合");
  }
  if (verticalGap > 0) {
    parts.push(`垂直间距 ${formatPx(verticalGap)}`);
  } else if (verticalGap < 0) {
    parts.push(`垂直重叠 ${formatPx(-verticalGap)}`);
  } else {
    parts.push("垂直贴合");
  }

  const aligned: string[] = [];
  if (alignment.left) aligned.push("左对齐");
  if (alignment.right) aligned.push("右对齐");
  if (alignment.top) aligned.push("顶对齐");
  if (alignment.bottom) aligned.push("底对齐");
  if (alignment.centerX) aligned.push("水平居中对齐");
  if (alignment.centerY) aligned.push("垂直居中对齐");
  if (aligned.length > 0) {
    parts.push(aligned.join("、"));
  }

  return parts.join("，");
}

function viewSummaryEntry(view: ViewRecord, rect: Rect, density: number): JsonObject {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  return {
    path: view.path,
    memAddr: view.memAddr,
    idStr: view.idStr,
    className: view.className,
    text: view.text,
    bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    size: {
      width,
      height,
      widthDp: toDp(width, density),
      heightDp: toDp(height, density),
    },
    center: { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 },
  };
}

function candidateSnapshot(view: ViewRecord): JsonObject {
  return {
    path: view.path,
    idStr: view.idStr,
    className: view.className,
    text: view.text,
    memAddr: view.memAddr,
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function truncateText(text: string | null, max: number): string {
  if (!text) {
    return "-";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTableRow(label: string, entry: JsonObject): string {
  const bounds = entry.bounds as JsonObject;
  const size = entry.size as JsonObject;
  const cells = [
    label,
    String(entry.path ?? "-"),
    String(entry.idStr ?? "-"),
    truncateText(stringValue(entry.text), 24),
    shortClassName(stringValue(entry.className)) || "-",
    `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`,
    `${size.width}×${size.height} (${size.widthDp ?? "?"}×${size.heightDp ?? "?"}dp)`,
  ];
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function buildMarkdown(result: JsonObject): string {
  const a = result.a as JsonObject;
  const b = result.b as JsonObject;
  const distance = result.distance as JsonObject;
  const edges = distance.edges as JsonObject;
  const alignment = distance.alignment as JsonObject;
  const alignedKeys = Object.entries(alignment)
    .filter(([, value]) => value === true)
    .map(([key]) => key);

  const lines: string[] = [];
  lines.push("# 元素距离测量", "");
  lines.push(`- 数据源：\`${result.source}\``);
  lines.push(`- 使用边界：${result.use}　容差：${result.tolerance}px　density：${result.density}`);
  lines.push("", "## A / B", "");
  lines.push("| | path | idStr | text | className | bounds (L,T,R,B) | size (px) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  lines.push(formatTableRow("A", a));
  lines.push(formatTableRow("B", b));
  lines.push("", "## 距离", "");
  lines.push(`- 关系：**${distance.relation}**`);
  lines.push(
    `- 水平间距：${distance.horizontalGap}px (${distance.horizontalGapDp ?? "?"}dp)　${(distance.horizontalGap as number) < 0 ? "（负数为重叠量）" : ""}`,
  );
  lines.push(
    `- 垂直间距：${distance.verticalGap}px (${distance.verticalGapDp ?? "?"}dp)　${(distance.verticalGap as number) < 0 ? "（负数为重叠量）" : ""}`,
  );
  lines.push(`- 中心点 dx / dy：${distance.centerDx}px / ${distance.centerDy}px　中心距离：${distance.centerDistance}px`);
  lines.push("- 边到边（带方向，正数表示前者在后者左/上侧）:");
  lines.push(`  - A.right → B.left：${edges.aRightToBLeft}px`);
  lines.push(`  - B.right → A.left：${edges.bRightToALeft}px`);
  lines.push(`  - A.bottom → B.top：${edges.aBottomToBTop}px`);
  lines.push(`  - B.bottom → A.top：${edges.bBottomToATop}px`);
  lines.push(`- 对齐（容差 ${result.tolerance}px）：${alignedKeys.length === 0 ? "无" : alignedKeys.join(", ")}`);
  lines.push("", `> ${distance.summary}`, "");
  return lines.join("\n");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options) {
    console.log(usage());
    return;
  }
  const { inputPath, rawA, rawB, selectorA, selectorB, useDraw, tolerance, pretty, markdown } = options;
  if (!(await pathExists(inputPath))) {
    throw new CliError("INPUT_NOT_FOUND", `文件不存在: ${inputPath}`);
  }
  const normalized = JSON.parse(await readFile(inputPath, "utf8")) as JsonObject;
  const views = loadViews(normalized);
  if (views.length === 0) {
    throw new CliError("NO_FLAT_VIEWS", "normalized.json 中未发现 flatViews，请确认是 parse-codelocator-file.ts 的产物");
  }
  const density = numberValue(normalized.density) ?? 0;

  const selectFor = (
    selector: SelectorPredicate[],
    raw: string,
    which: "a" | "b",
  ): { which: "a" | "b"; raw: string; matched: ViewRecord[] } => {
    const matched = takeIndex(views.filter((view) => matchSelector(view, selector)), selector);
    return { which, raw, matched };
  };

  const aHit = selectFor(selectorA, rawA, "a");
  const bHit = selectFor(selectorB, rawB, "b");

  for (const hit of [aHit, bHit]) {
    if (hit.matched.length === 0) {
      printJson(
        {
          status: "not_found",
          which: hit.which,
          selector: hit.raw,
          hint: "对照 normalized.json 的 flatViews，换一组更精确的 selector（path / idstr / mem 优先）",
        },
        pretty,
      );
      return;
    }
    if (hit.matched.length > 1) {
      printJson(
        {
          status: "ambiguous",
          which: hit.which,
          selector: hit.raw,
          matchedCount: hit.matched.length,
          candidates: hit.matched.slice(0, 10).map(candidateSnapshot),
          hint: "追加更具体的条件（如 path=...、mem=...）或加 index=N 选第 N 个候选",
        },
        pretty,
      );
      return;
    }
  }

  const a = aHit.matched[0];
  const b = bHit.matched[0];
  const rectA = rectFor(a, useDraw);
  const rectB = rectFor(b, useDraw);
  if (!rectA || !rectB) {
    throw new CliError("MISSING_BOUNDS", `命中节点缺少 bounds 数据（A=${rectA ? "ok" : "missing"}，B=${rectB ? "ok" : "missing"}）`);
  }
  const distance = computeDistance(rectA, rectB, tolerance, density);
  const result: JsonObject = {
    status: "ok",
    source: inputPath,
    density,
    use: useDraw ? "drawBounds" : "bounds",
    tolerance,
    a: viewSummaryEntry(a, rectA, density),
    b: viewSummaryEntry(b, rectB, density),
    distance,
  };

  if (markdown) {
    console.log(buildMarkdown(result));
  } else {
    printJson(result, pretty);
  }
}

main().catch((error: unknown) => {
  const pretty = prettyRequestedFromArgv(process.argv.slice(2));
  printJson(
    {
      status: "error",
      error: {
        code: errorCodeOf(error),
        message: errorMessageOf(error),
      },
    },
    pretty,
  );
  process.exitCode = 1;
});
