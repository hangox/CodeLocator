#!/usr/bin/env node

// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { basename, extname, join, relative, resolve } from "node:path";
// @ts-ignore 直接运行于 Node，内置模块类型由运行时保证
import { Buffer } from "node:buffer";

declare const process: { argv: string[]; exitCode?: number };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type ParsedFile = {
  tag: string;
  version: string;
  application: JsonObject;
  pngBytes: Buffer;
  offsets: {
    applicationJsonStart: number;
    applicationJsonEnd: number;
    pngStart: number;
  };
};

type CliOptions = {
  inputPath: string;
  outputDir: string;
  srcDir?: string;
  treeDepth: number;
  pretty: boolean;
};

type SourceLookupResult = {
  xmlName: string;
  layoutPaths: string[];
  ownerFiles: string[];
};

const APP_KEYS: Record<string, string> = {
  ag: "className",
  b5: "isMainThread",
  b6: "hClassName",
  b7: "activity",
  b8: "file",
  b9: "showInfos",
  ba: "colorInfo",
  bb: "appInfo",
  bc: "schemaInfos",
  bd: "packageName",
  be: "projectName",
  bf: "isDebug",
  bg: "fromSdk",
  bh: "hasSDK",
  bi: "grabTime",
  bj: "density",
  bk: "densityDpi",
  bl: "statusBarHeight",
  bm: "navigationBarHeight",
  bn: "orientation",
  bo: "sdkVersion",
  bp: "minPluginVersion",
  bq: "screenWidth",
  br: "screenHeight",
  bs: "realWidth",
  bt: "realHeight",
  bu: "overrideScreenWidth",
  bv: "overrideScreenHeight",
  bw: "physicalWidth",
  bx: "physicalHeight",
  by: "androidVersion",
  bz: "deviceInfo",
  c0: "fetchUrl",
};

const ACTIVITY_KEYS: Record<string, string> = {
  ag: "className",
  af: "memAddr",
  cj: "decorViews",
  ck: "fragments",
  cl: "startInfo",
};

const FRAGMENT_KEYS: Record<string, string> = {
  a: "children",
  cb: "viewMemAddr",
  ag: "className",
  cc: "tag",
  ad: "id",
  af: "memAddr",
  cd: "visible",
  ce: "added",
  cf: "userVisibleHint",
};

const VIEW_KEYS: Record<string, string> = {
  a: "children",
  b: "topOffset",
  c: "leftOffset",
  d: "left",
  e: "right",
  f: "top",
  g: "bottom",
  h: "scrollX",
  i: "scrollY",
  j: "scaleX",
  k: "scaleY",
  l: "translationX",
  m: "translationY",
  n: "drawTop",
  o: "drawBottom",
  p: "drawLeft",
  q: "drawRight",
  r: "paddingTop",
  s: "paddingBottom",
  t: "paddingLeft",
  u: "paddingRight",
  v: "marginTop",
  w: "marginBottom",
  x: "marginLeft",
  y: "marginRight",
  z: "layoutWidth",
  a0: "layoutHeight",
  a1: "clickable",
  a2: "longClickable",
  a3: "focusable",
  a4: "pressed",
  a5: "selected",
  a6: "focused",
  a7: "enabled",
  a8: "flags",
  a9: "canProviderData",
  aa: "type",
  ab: "visibility",
  ac: "idStr",
  ad: "id",
  ae: "alpha",
  af: "memAddr",
  ag: "className",
  ah: "clickTag",
  ai: "touchTag",
  aj: "findViewByIdTag",
  ak: "xmlTag",
  al: "drawableTag",
  am: "scaleType",
  an: "viewHolderTag",
  ao: "adapterTag",
  ap: "backgroundColor",
  aq: "text",
  ar: "span",
  as: "textColor",
  at: "textSize",
  au: "spacingAdd",
  av: "lineHeight",
  aw: "textAlignment",
  ax: "zIndex",
  ay: "xmlJumpInfo",
  az: "imagePath",
  b0: "extraInfos",
  b1: "shadowDx",
  b2: "shadowDy",
  b3: "shadowRadius",
  b4: "shadowColor",
  df: "pivotX",
  dg: "pivotY",
  dk: "slopBoundLeft",
  dl: "slopBoundRight",
  dm: "slopBoundUp",
  dn: "slopBoundBottom",
  do: "layoutRequested",
};

const FILE_KEYS: Record<string, string> = {
  a: "children",
  c1: "length",
  c2: "directory",
  c3: "exists",
  c4: "inSDCard",
  c5: "lastModified",
  c6: "name",
  c7: "absoluteFilePath",
  c8: "customTag",
  c9: "editable",
  ca: "isJson",
};

const JUMP_KEYS: Record<string, string> = {
  cz: "fileName",
  d0: "lineCount",
  ad: "id",
  dh: "isViewBinding",
};

const DEFAULT_TREE_DEPTH = 6;
const SKIP_DIRS = new Set([
  ".git",
  ".gradle",
  ".idea",
  "build",
  "intermediates",
  "node_modules",
  "out",
  "stripped.dir",
  "target",
]);

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

const OUTPUT_PURPOSES = {
  summary: "首选入口，80% 任务从这里开始（含 fragment 树/文本→xml 映射/layout 汇总/view tree）",
  xml_to_source: "改源码前必看：layout xml → 持有的 Fragment/Adapter 类（仅 --src 时生成）",
  screenshot: "视觉对照：按坐标/区域定位 view",
  normalized: "summary 不够时回这里：activity.decorViews 完整 view 树 + flatViews 全量",
  raw: "兜底：SDK 短字段原始数据（ak/ay 等），优先用 normalized",
  metadata: "解析诊断/排错",
} as const;

function buildManifest(params: {
  normalized: JsonObject;
  rawJsonPath: string;
  normalizedJsonPath: string;
  summaryPath: string;
  xmlToSourcePath?: string;
  screenshotPath: string;
  metadataPath: string;
  parseMs: number;
}): JsonObject {
  const activity = objectValue(params.normalized.activity);
  const flatViews = arrayValue(params.normalized.flatViews);
  const outputs: JsonObject[] = [
    {
      path: params.summaryPath,
      kind: "summary",
      priority: 1,
      purpose: OUTPUT_PURPOSES.summary,
    },
  ];
  if (params.xmlToSourcePath) {
    outputs.push({
      path: params.xmlToSourcePath,
      kind: "xml_to_source",
      priority: 2,
      purpose: OUTPUT_PURPOSES.xml_to_source,
    });
  }
  outputs.push(
    {
      path: params.screenshotPath,
      kind: "screenshot",
      priority: 3,
      purpose: OUTPUT_PURPOSES.screenshot,
    },
    {
      path: params.normalizedJsonPath,
      kind: "normalized",
      priority: 4,
      purpose: OUTPUT_PURPOSES.normalized,
    },
    {
      path: params.rawJsonPath,
      kind: "raw",
      priority: 5,
      purpose: OUTPUT_PURPOSES.raw,
    },
    {
      path: params.metadataPath,
      kind: "metadata",
      priority: 6,
      purpose: OUTPUT_PURPOSES.metadata,
    },
  );
  outputs.sort((left, right) => (numberValue(left.priority) ?? 0) - (numberValue(right.priority) ?? 0));

  const nextSteps = ["Read outputs[priority=1].path first"];
  if (params.xmlToSourcePath) {
    nextSteps.push("If task involves modifying Kotlin/Java source, also Read outputs[kind=xml_to_source].path");
  }
  nextSteps.push(
    "If summary doesn't cover target view, Read outputs[kind=normalized].path",
    "Use outputs[kind=screenshot].path for visual position lookup",
  );

  return {
    status: "ok",
    stats: {
      package: displayValue(params.normalized.packageName),
      activity: shortClassName(activity?.className),
      flatViews: flatViews.length,
      androidVersion: numberValue(params.normalized.androidVersion) ?? displayValue(params.normalized.androidVersion),
      density: numberValue(params.normalized.density) ?? displayValue(params.normalized.density),
      parseMs: params.parseMs,
    },
    outputs,
    next_steps: nextSteps,
  };
}

function usage(): string {
  return [
    "用法:",
    "  node .claude/skills/codelocator/scripts/parse-codelocator-file.ts <file.codeLocator> [output-dir] [--src <android-project-root>] [--tree-depth <N>] [--pretty]",
    "  node .claude/skills/codelocator/scripts/parse-codelocator-file.ts <file.codeLocator> [output-dir] [--src=<android-project-root>] [--tree-depth=<N>] [--pretty]",
    "",
    "输出:",
    "  <base>.raw.json          原始 WApplication JSON",
    "  <base>.normalized.json   常用字段还原后的 JSON，含 flatViews",
    "  <base>.summary.md        人类可读摘要，优先阅读",
    "  <base>.xml_to_source.md  layout XML 到源码映射（仅 --src 时生成）",
    "  <base>.screenshot.png    历史截图",
    "  <base>.metadata.json     文件头、版本、长度和偏移信息",
  ].join("\n");
}

function readSizedString(buffer: Buffer, offset: number): { value: string; nextOffset: number; length: number } {
  if (offset + 4 > buffer.length) {
    throw new Error(`偏移 ${offset} 处缺少长度字段`);
  }
  const length = buffer.readInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length < 0 || end > buffer.length) {
    throw new Error(`偏移 ${offset} 处长度非法: ${length}`);
  }
  return {
    value: buffer.subarray(start, end).toString("utf8"),
    nextOffset: end,
    length,
  };
}

function parseCodeLocatorFile(buffer: Buffer): ParsedFile {
  const tag = readSizedString(buffer, 0);
  if (tag.value !== "CodeLocator") {
    throw new Error(`不是 CodeLocator 文件: tag=${JSON.stringify(tag.value)}`);
  }

  const version = readSizedString(buffer, tag.nextOffset);
  const applicationJsonStart = version.nextOffset + 4;
  const appLength = buffer.readInt32BE(version.nextOffset);
  const appStart = version.nextOffset + 4;
  const appEnd = appStart + appLength;
  if (appLength < 0 || appEnd > buffer.length) {
    throw new Error(`WApplication JSON 长度非法: ${appLength}`);
  }

  const appJson = buffer.subarray(appStart, appEnd).toString("utf8");
  const application = JSON.parse(appJson) as JsonObject;
  const pngBytes = buffer.subarray(appEnd);
  if (pngBytes.length < 8 || pngBytes.subarray(0, 8).compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) !== 0) {
    throw new Error("截图部分不是 PNG 数据");
  }

  return {
    tag: tag.value,
    version: version.value,
    application,
    pngBytes,
    offsets: {
      applicationJsonStart,
      applicationJsonEnd: appEnd,
      pngStart: appEnd,
    },
  };
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function renameObject(source: JsonObject | undefined, mapping: Record<string, string>): JsonObject | undefined {
  if (!source) {
    return undefined;
  }
  const target: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    target[mapping[key] ?? key] = value;
  }
  return target;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseJumpTag(tag: JsonValue | undefined): JsonObject[] {
  const raw = stringValue(tag);
  if (!raw) {
    return [];
  }
  return raw.split("|").flatMap((item) => {
    const text = item.trim();
    if (!text) {
      return [];
    }
    const parts = text.split(":");
    if (parts.length < 2) {
      return [{ raw: text }];
    }
    const result: JsonObject = { raw: text, fileName: parts[0] };
    if (parts[1].startsWith("id/")) {
      result.id = parts[1].slice("id/".length);
    } else if (parts[1].startsWith("bind_id/")) {
      result.id = parts[1].slice("bind_id/".length);
      result.isViewBinding = true;
      const line = Number.parseInt(parts[2] ?? "", 10);
      if (!Number.isNaN(line)) {
        result.line = line;
      }
    } else {
      const line = Number.parseInt(parts[1], 10);
      if (!Number.isNaN(line)) {
        result.line = line;
      }
    }
    return [result];
  });
}

function idFromIdStr(idStr: JsonValue | undefined): string | undefined {
  const raw = stringValue(idStr);
  if (!raw) {
    return undefined;
  }
  if (raw.startsWith("app:")) {
    return raw.slice("app:".length);
  }
  if (raw.startsWith("android:")) {
    return raw.slice("android:".length);
  }
  if (raw.startsWith("id/")) {
    return raw.slice("id/".length);
  }
  return raw;
}

function normalizeJump(value: JsonValue | undefined): JsonValue | undefined {
  const obj = objectValue(value);
  if (!obj) {
    return value;
  }
  return renameObject(obj, JUMP_KEYS);
}

function normalizeFile(raw: JsonValue | undefined): JsonValue | undefined {
  const obj = renameObject(objectValue(raw), FILE_KEYS);
  if (!obj) {
    return undefined;
  }
  obj.children = arrayValue(obj.children).map(normalizeFile).filter((item): item is JsonValue => item !== undefined);
  return obj;
}

function collectFragmentRoots(fragments: JsonValue[]): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (fragment: JsonValue): void => {
    const normalized = renameObject(objectValue(fragment), FRAGMENT_KEYS);
    if (!normalized) {
      return;
    }
    const viewMemAddr = stringValue(normalized.viewMemAddr);
    const className = stringValue(normalized.className);
    if (viewMemAddr && className) {
      result.set(viewMemAddr, className);
    }
    for (const child of arrayValue(normalized.children)) {
      visit(child);
    }
  };
  fragments.forEach(visit);
  return result;
}

function normalizeFragment(raw: JsonValue | undefined): JsonValue | undefined {
  const obj = renameObject(objectValue(raw), FRAGMENT_KEYS);
  if (!obj) {
    return undefined;
  }
  obj.children = arrayValue(obj.children).map(normalizeFragment).filter((item): item is JsonValue => item !== undefined);
  return obj;
}

function normalizeView(raw: JsonValue | undefined, path: string, fragmentRoots: Map<string, string>, flatViews: JsonObject[]): JsonValue | undefined {
  const obj = renameObject(objectValue(raw), VIEW_KEYS);
  if (!obj) {
    return undefined;
  }

  const children = arrayValue(obj.children);
  const idStr = obj.idStr;
  const xmlTag = stringValue(obj.xmlTag);
  const clickTag = obj.clickTag;
  const touchTag = obj.touchTag;
  const findViewByIdTag = obj.findViewByIdTag;
  const memAddr = stringValue(obj.memAddr);
  const fragmentClassName = memAddr ? fragmentRoots.get(memAddr) : undefined;

  const normalized: JsonObject = {
    path,
    zIndex: obj.zIndex,
    className: obj.className,
    memAddr: obj.memAddr,
    fragmentClassName: fragmentClassName ?? null,
    id: obj.id,
    idStr,
    text: obj.text,
    visibility: obj.visibility,
    enabled: obj.enabled,
    clickable: obj.clickable,
    longClickable: obj.longClickable,
    bounds: {
      left: obj.left,
      top: obj.top,
      right: obj.right,
      bottom: obj.bottom,
    },
    drawBounds: {
      left: obj.drawLeft,
      top: obj.drawTop,
      right: obj.drawRight,
      bottom: obj.drawBottom,
    },
    layout: {
      width: obj.layoutWidth,
      height: obj.layoutHeight,
      paddingLeft: obj.paddingLeft,
      paddingTop: obj.paddingTop,
      paddingRight: obj.paddingRight,
      paddingBottom: obj.paddingBottom,
      marginLeft: obj.marginLeft,
      marginTop: obj.marginTop,
      marginRight: obj.marginRight,
      marginBottom: obj.marginBottom,
    },
    transform: {
      scrollX: obj.scrollX,
      scrollY: obj.scrollY,
      scaleX: obj.scaleX,
      scaleY: obj.scaleY,
      translationX: obj.translationX,
      translationY: obj.translationY,
      pivotX: obj.pivotX,
      pivotY: obj.pivotY,
      alpha: obj.alpha,
    },
    tags: {
      xmlTag: xmlTag ?? null,
      clickTag,
      touchTag,
      findViewByIdTag,
      drawableTag: obj.drawableTag,
      viewHolderTag: obj.viewHolderTag,
      adapterTag: obj.adapterTag,
      backgroundColor: obj.backgroundColor,
    },
    jumps: {
      xml: xmlTag ? [{ fileName: xmlTag, id: idFromIdStr(idStr) ?? null }] : [],
      click: parseJumpTag(clickTag),
      touch: parseJumpTag(touchTag),
      findViewById: parseJumpTag(findViewByIdTag),
      xmlJumpInfo: normalizeJump(obj.xmlJumpInfo) ?? null,
    },
    textInfo: {
      span: obj.span,
      textColor: obj.textColor,
      textSize: obj.textSize,
      lineHeight: obj.lineHeight,
      spacingAdd: obj.spacingAdd,
      textAlignment: obj.textAlignment,
    },
    imageInfo: {
      imagePath: obj.imagePath,
      scaleType: obj.scaleType,
      drawableTag: obj.drawableTag,
    },
    extraInfos: obj.extraInfos,
    children: [],
  };

  flatViews.push({
    path,
    zIndex: normalized.zIndex,
    className: normalized.className,
    memAddr: normalized.memAddr,
    fragmentClassName: fragmentClassName ?? null,
    idStr,
    text: normalized.text,
    visibility: normalized.visibility,
    bounds: normalized.bounds,
    drawBounds: normalized.drawBounds,
    tags: normalized.tags,
    jumps: normalized.jumps,
  });

  normalized.children = children
    .map((child, index) => normalizeView(child, `${path}/${index}`, fragmentRoots, flatViews))
    .filter((item): item is JsonValue => item !== undefined);
  return normalized;
}

function normalizeActivity(raw: JsonValue | undefined, flatViews: JsonObject[]): JsonValue | undefined {
  const obj = renameObject(objectValue(raw), ACTIVITY_KEYS);
  if (!obj) {
    return undefined;
  }
  const fragments = arrayValue(obj.fragments);
  const fragmentRoots = collectFragmentRoots(fragments);
  obj.fragments = fragments.map(normalizeFragment).filter((item): item is JsonValue => item !== undefined);
  obj.decorViews = arrayValue(obj.decorViews)
    .map((view, index) => normalizeView(view, `decorViews/${index}`, fragmentRoots, flatViews))
    .filter((item): item is JsonValue => item !== undefined);
  obj.openActivityJump = parseJumpTag(obj.startInfo);
  return obj;
}

function normalizeApplication(raw: JsonObject): JsonObject {
  const flatViews: JsonObject[] = [];
  const obj = renameObject(raw, APP_KEYS) ?? {};
  obj.activity = normalizeActivity(obj.activity, flatViews) ?? null;
  obj.file = normalizeFile(obj.file) ?? null;
  obj.flatViews = flatViews;
  obj.screen = {
    screenWidth: obj.screenWidth,
    screenHeight: obj.screenHeight,
    realWidth: obj.realWidth,
    realHeight: obj.realHeight,
    overrideScreenWidth: obj.overrideScreenWidth,
    overrideScreenHeight: obj.overrideScreenHeight,
    physicalWidth: obj.physicalWidth,
    physicalHeight: obj.physicalHeight,
    density: obj.density,
    densityDpi: obj.densityDpi,
    statusBarHeight: obj.statusBarHeight,
    navigationBarHeight: obj.navigationBarHeight,
    orientation: obj.orientation,
  };
  return obj;
}

function parseCliArgs(args: string[]): CliOptions | undefined {
  if (args.length === 0) {
    return undefined;
  }

  const positionals: string[] = [];
  let srcDir: string | undefined;
  let treeDepth = DEFAULT_TREE_DEPTH;
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return undefined;
    }
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--src") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_SRC_DIR", "--src 缺少目录参数");
      }
      srcDir = resolve(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--src=")) {
      srcDir = resolve(arg.slice("--src=".length));
      continue;
    }
    if (arg === "--tree-depth") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("MISSING_TREE_DEPTH", "--tree-depth 缺少数值参数");
      }
      treeDepth = parseTreeDepth(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--tree-depth=")) {
      treeDepth = parseTreeDepth(arg.slice("--tree-depth=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliError("UNKNOWN_OPTION", `未知参数: ${arg}`);
    }
    positionals.push(arg);
  }

  const [inputArg, outputArg] = positionals;
  if (!inputArg) {
    return undefined;
  }

  const inputPath = resolve(inputArg);
  const outputDir = resolve(outputArg ?? `${inputPath}.parsed`);
  return { inputPath, outputDir, srcDir, treeDepth, pretty };
}

function parseTreeDepth(raw: string): number {
  const depth = Number.parseInt(raw, 10);
  if (!Number.isFinite(depth) || depth <= 0) {
    throw new CliError("INVALID_TREE_DEPTH", `--tree-depth 必须是正整数: ${raw}`);
  }
  return depth;
}

function shortClassName(raw: JsonValue | undefined): string {
  const value = stringValue(raw) ?? "-";
  const lastDotIndex = value.lastIndexOf(".");
  return lastDotIndex >= 0 ? value.slice(lastDotIndex + 1) : value;
}

function displayValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "string") {
    return value.trim() || "-";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatGrabTime(value: JsonValue | undefined): string {
  if (typeof value === "number") {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) {
      return `${date.toLocaleString("zh-CN", { hour12: false })} (${value})`;
    }
    return String(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return "-";
    }
    const numeric = Number(text);
    if (!Number.isNaN(numeric)) {
      return formatGrabTime(numeric);
    }
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      return `${date.toLocaleString("zh-CN", { hour12: false })} (${text})`;
    }
    return text;
  }
  return "-";
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function comparePath(left: string, right: string): number {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    const aNumber = Number.parseInt(a, 10);
    const bNumber = Number.parseInt(b, 10);
    if (!Number.isNaN(aNumber) && !Number.isNaN(bNumber)) {
      if (aNumber !== bNumber) {
        return aNumber - bNumber;
      }
      continue;
    }
    if (a !== b) {
      return a.localeCompare(b);
    }
  }
  return 0;
}

function collectFragmentLines(fragments: JsonValue[], depth: number, lines: string[]): void {
  for (const fragment of fragments) {
    const fragmentObject = objectValue(fragment);
    if (!fragmentObject) {
      continue;
    }
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${shortClassName(fragmentObject.className)}  [tag=${displayValue(fragmentObject.tag)}]  root=${displayValue(fragmentObject.viewMemAddr)}`);
    collectFragmentLines(arrayValue(fragmentObject.children), depth + 1, lines);
  }
}

function collectJumpLocations(view: JsonObject): string[] {
  const jumps = objectValue(view.jumps);
  const result = new Set<string>();
  for (const key of ["click", "touch"]) {
    for (const item of arrayValue(jumps?.[key])) {
      const jump = objectValue(item);
      if (!jump) {
        continue;
      }
      const fileName = stringValue(jump.fileName);
      const line = numberValue(jump.line);
      if (fileName && line !== undefined) {
        result.add(`${fileName}:${line}`);
      }
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

function collectXmlTagCounts(flatViews: JsonObject[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const view of flatViews) {
    const tags = objectValue(view.tags);
    const xmlTag = stringValue(tags?.xmlTag);
    if (!xmlTag) {
      continue;
    }
    counts.set(xmlTag, (counts.get(xmlTag) ?? 0) + 1);
  }
  return counts;
}

function numberOrFallback(value: JsonValue | undefined, fallback: string): string {
  const number = numberValue(value);
  return number === undefined ? fallback : String(number);
}

function pxToDp(px: number, density: number): number {
  if (!Number.isFinite(density) || density <= 0) {
    return px;
  }
  return Math.round(px / density);
}

function renderViewTree(view: JsonValue | undefined, density: number, maxDepth: number, depth: number, lines: string[]): void {
  const viewObject = objectValue(view);
  if (!viewObject) {
    return;
  }

  const bounds = objectValue(viewObject.bounds);
  const left = numberValue(bounds?.left);
  const top = numberValue(bounds?.top);
  const right = numberValue(bounds?.right);
  const bottom = numberValue(bounds?.bottom);
  const width = left !== undefined && right !== undefined ? right - left : undefined;
  const height = top !== undefined && bottom !== undefined ? bottom - top : undefined;
  const childCount = arrayValue(viewObject.children).length;
  const indent = "  ".repeat(depth);
  const widthText = width === undefined ? "?" : String(width);
  const heightText = height === undefined ? "?" : String(height);
  const widthDpText = width === undefined ? "?" : String(pxToDp(width, density));
  const heightDpText = height === undefined ? "?" : String(pxToDp(height, density));
  lines.push(
    `${indent}(${childCount}) ${shortClassName(viewObject.className)} [${numberOrFallback(bounds?.left, "?")},${numberOrFallback(bounds?.top, "?")}][${numberOrFallback(bounds?.right, "?")},${numberOrFallback(bounds?.bottom, "?")}]  ${widthText}px, ${heightText}px (${widthDpText}dp, ${heightDpText}dp)`,
  );

  if (depth + 1 >= maxDepth) {
    return;
  }
  for (const child of arrayValue(viewObject.children)) {
    renderViewTree(child, density, maxDepth, depth + 1, lines);
  }
}

function summarizeOwnerFiles(ownerFiles: string[]): string {
  if (ownerFiles.length === 0) {
    return "-";
  }
  if (ownerFiles.length <= 3) {
    return ownerFiles.join(", ");
  }
  return `${ownerFiles.slice(0, 3).join(", ")} … (+${ownerFiles.length - 3})`;
}

function buildSummaryMarkdown(normalized: JsonObject, treeDepth: number, xmlOwnerLookup?: Map<string, string[]>): string {
  const activity = objectValue(normalized.activity);
  const fragments = arrayValue(activity?.fragments);
  const flatViews = arrayValue(normalized.flatViews)
    .map((item) => objectValue(item))
    .filter((item): item is JsonObject => item !== undefined);
  const xmlTagCounts = collectXmlTagCounts(flatViews);
  const lines: string[] = [];

  lines.push(
    "# CodeLocator 摘要",
    "",
    "> **本文件覆盖 80% 场景。如果不够：**",
    "> - 改源码 → 同目录 `*.xml_to_source.md`",
    "> - 看完整 view 树结构 → 同目录 `*.normalized.json` 的 `activity.decorViews[]`",
    "> - 视觉对照 → 同目录 `*.screenshot.png`",
    "> - SDK 原始字段（兜底）→ 同目录 `*.raw.json`",
    "",
    "## 基本信息",
    "",
  );
  lines.push(`- package: ${displayValue(normalized.packageName)}`);
  lines.push(`- Activity className: ${displayValue(activity?.className)}`);
  lines.push(`- grabTime: ${formatGrabTime(normalized.grabTime)}`);
  lines.push(`- density / densityDpi: ${displayValue(normalized.density)} / ${displayValue(normalized.densityDpi)}`);
  lines.push(`- screen WxH: ${displayValue(normalized.screenWidth)} x ${displayValue(normalized.screenHeight)}`);
  lines.push(`- androidVersion: ${displayValue(normalized.androidVersion)}`);
  lines.push(`- fromSdk: ${displayValue(normalized.fromSdk)}`);
  lines.push(`- hasSDK: ${displayValue(normalized.hasSDK)}`);
  lines.push(`- flatViews: ${flatViews.length}`);

  lines.push("", "## Fragment 列表", "");
  if (fragments.length === 0) {
    lines.push("- 无");
  } else {
    collectFragmentLines(fragments, 0, lines);
  }

  lines.push("", "## 关键 View 摘要", "", "| text | idStr | xmlTag(fileName) | className | path |", "| --- | --- | --- | --- | --- |");
  const textViews = flatViews
    .filter((view) => (stringValue(view.text) ?? "").trim().length > 0)
    .sort((left, right) => comparePath(stringValue(left.path) ?? "", stringValue(right.path) ?? ""));
  if (textViews.length === 0) {
    lines.push("| - | - | - | - | - |");
  } else {
    for (const view of textViews) {
      const tags = objectValue(view.tags);
      const jumpLocations = collectJumpLocations(view);
      const className = `${shortClassName(view.className)}${jumpLocations.length > 0 ? ` → ${jumpLocations.join(", ")}` : ""}`;
      lines.push(`| ${escapeMarkdownCell(displayValue(view.text))} | ${escapeMarkdownCell(displayValue(view.idStr))} | ${escapeMarkdownCell(displayValue(tags?.xmlTag))} | ${escapeMarkdownCell(className)} | ${escapeMarkdownCell(displayValue(view.path))} |`);
    }
  }

  lines.push("", "## layout XML 汇总", "");
  if (xmlOwnerLookup) {
    lines.push("| xml | count | 主要持有类 |", "| --- | ---: | --- |");
  } else {
    lines.push("| xml | count |", "| --- | ---: |");
  }
  if (xmlTagCounts.size === 0) {
    lines.push(xmlOwnerLookup ? "| - | 0 | - |" : "| - | 0 |");
  } else {
    for (const [xmlTag, count] of [...xmlTagCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      if (xmlOwnerLookup) {
        const ownerFiles = [...(xmlOwnerLookup.get(xmlTag) ?? [])];
        lines.push(`| ${escapeMarkdownCell(xmlTag)} | ${count} | ${escapeMarkdownCell(summarizeOwnerFiles(ownerFiles))} |`);
      } else {
        lines.push(`| ${escapeMarkdownCell(xmlTag)} | ${count} |`);
      }
    }
  }

  lines.push("", `## View Tree（最多 ${treeDepth} 层）`, "");
  const decorViews = arrayValue(activity?.decorViews);
  if (decorViews.length === 0) {
    lines.push("- 无 decorViews");
  } else {
    const density = numberValue(normalized.density) ?? 1;
    renderViewTree(decorViews[0], density, treeDepth, 0, lines);
  }

  return `${lines.join("\n")}\n`;
}

function toPascalCase(baseName: string): string {
  return baseName
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function normalizeRelativePath(root: string, targetPath: string): string {
  return relative(root, targetPath).split("\\").join("/");
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

async function walkFiles(rootDir: string, matcher: (fullPath: string, relativePath: string) => boolean): Promise<string[]> {
  const result: string[] = [];

  const visit = async (currentDir: string): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && shouldSkipDir(entry.name)) {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = normalizeRelativePath(rootDir, fullPath);
      if (matcher(fullPath, relativePath)) {
        result.push(fullPath);
      }
    }
  };

  await visit(rootDir);
  return result;
}

function isLayoutXmlRelativePath(relativePath: string): boolean {
  return /(^|\/)src\/main\/res\/layout\/[^/]+\.xml$/u.test(relativePath);
}

async function buildLayoutPathLookup(srcDir: string, xmlNames: string[]): Promise<Map<string, string[]>> {
  const wantedXmlNames = new Set(xmlNames);
  const layoutFiles = await walkFiles(srcDir, (_fullPath, relativePath) => isLayoutXmlRelativePath(relativePath));
  const layoutMap = new Map<string, string[]>();
  for (const fullPath of layoutFiles) {
    const fileName = basename(fullPath);
    if (!wantedXmlNames.has(fileName)) {
      continue;
    }
    const bucket = layoutMap.get(fileName) ?? [];
    bucket.push(normalizeRelativePath(srcDir, fullPath));
    layoutMap.set(fileName, bucket);
  }
  for (const [xmlName, layoutPaths] of layoutMap.entries()) {
    layoutMap.set(xmlName, [...new Set(layoutPaths)].sort((left, right) => left.localeCompare(right)));
  }
  return layoutMap;
}

async function buildXmlOwnerLookup(srcDir: string, xmlNames: string[]): Promise<Map<string, string[]>> {
  const sortedXmlNames = [...new Set(xmlNames)].sort((left, right) => left.localeCompare(right));
  const ownerMap = new Map<string, string[]>(sortedXmlNames.map((xmlName) => [xmlName, []]));
  const codeFiles = await walkFiles(srcDir, (fullPath) => fullPath.endsWith(".kt") || fullPath.endsWith(".java"));
  const tokens = sortedXmlNames.map((xmlName) => {
    const baseName = xmlName.replace(/\.xml$/u, "");
    return {
      xmlName,
      layoutToken: `R.layout.${baseName}`,
      bindingToken: `${toPascalCase(baseName)}Binding`,
    };
  });

  for (const codeFile of codeFiles) {
    const content = await readFile(codeFile, "utf8");
    const relativeCodePath = normalizeRelativePath(srcDir, codeFile);
    for (const token of tokens) {
      if (!content.includes(token.layoutToken) && !content.includes(token.bindingToken)) {
        continue;
      }
      const ownerFiles = ownerMap.get(token.xmlName);
      if (!ownerFiles) {
        continue;
      }
      ownerFiles.push(relativeCodePath);
    }
  }

  for (const [xmlName, ownerFiles] of ownerMap.entries()) {
    ownerMap.set(xmlName, [...new Set(ownerFiles)].sort((left, right) => left.localeCompare(right)));
  }
  return ownerMap;
}

async function buildXmlToSourceMarkdown(srcDir: string, xmlNames: string[], xmlOwnerLookup?: Map<string, string[]>): Promise<string> {
  const sortedXmlNames = [...new Set(xmlNames)].sort((left, right) => left.localeCompare(right));
  const layoutMap = await buildLayoutPathLookup(srcDir, sortedXmlNames);
  const ownerMap = xmlOwnerLookup ?? await buildXmlOwnerLookup(srcDir, sortedXmlNames);
  const results: SourceLookupResult[] = sortedXmlNames.map((xmlName) => ({
    xmlName,
    layoutPaths: [...(layoutMap.get(xmlName) ?? [])],
    ownerFiles: [...(ownerMap.get(xmlName) ?? [])],
  }));

  const lines: string[] = [];
  lines.push("# layout XML 到源码映射", "", "| xml | layout 路径 | 持有类（多个） |", "| --- | --- | --- |");
  for (const result of results) {
    if (result.layoutPaths.length === 0) {
      lines.push(`| ${escapeMarkdownCell(result.xmlName)} | NOT FOUND | - |`);
      continue;
    }
    lines.push(`| ${escapeMarkdownCell(result.xmlName)} | ${escapeMarkdownCell(result.layoutPaths.join("\n"))} | ${escapeMarkdownCell(result.ownerFiles.length > 0 ? result.ownerFiles.join("\n") : "-")} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const startAt = Date.now();
  const options = parseCliArgs(process.argv.slice(2));
  if (!options) {
    console.log(usage());
    return;
  }

  const { inputPath, outputDir, srcDir, treeDepth, pretty } = options;
  const buffer = await readFile(inputPath);
  const parsed = parseCodeLocatorFile(buffer);
  const normalized = normalizeApplication(parsed.application);

  await mkdir(outputDir, { recursive: true });

  const ext = extname(inputPath);
  const base = basename(inputPath, ext || ".codeLocator");
  const rawJsonPath = join(outputDir, `${base}.raw.json`);
  const normalizedJsonPath = join(outputDir, `${base}.normalized.json`);
  const summaryPath = join(outputDir, `${base}.summary.md`);
  const xmlToSourcePath = join(outputDir, `${base}.xml_to_source.md`);
  const screenshotPath = join(outputDir, `${base}.screenshot.png`);
  const metadataPath = join(outputDir, `${base}.metadata.json`);

  const flatViews = arrayValue(normalized.flatViews)
    .map((item) => objectValue(item))
    .filter((item): item is JsonObject => item !== undefined);
  const xmlNames = [...collectXmlTagCounts(flatViews).keys()];
  let xmlOwnerLookup: Map<string, string[]> | undefined;
  let generatedXmlToSourcePath: string | undefined;
  if (srcDir) {
    if (await pathExists(srcDir)) {
      xmlOwnerLookup = await buildXmlOwnerLookup(srcDir, xmlNames);
      await writeFile(xmlToSourcePath, await buildXmlToSourceMarkdown(srcDir, xmlNames, xmlOwnerLookup), "utf8");
      generatedXmlToSourcePath = xmlToSourcePath;
    } else {
      console.warn(`警告: 源码目录不存在，跳过 xml_to_source.md: ${srcDir}`);
    }
  }

  await writeFile(rawJsonPath, `${JSON.stringify(parsed.application, null, 2)}\n`, "utf8");
  await writeFile(normalizedJsonPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, buildSummaryMarkdown(normalized, treeDepth, xmlOwnerLookup), "utf8");
  await writeFile(screenshotPath, parsed.pngBytes);
  await writeFile(metadataPath, `${JSON.stringify({
    source: inputPath,
    tag: parsed.tag,
    version: parsed.version,
    totalBytes: buffer.length,
    applicationJsonBytes: parsed.offsets.applicationJsonEnd - parsed.offsets.applicationJsonStart,
    pngBytes: parsed.pngBytes.length,
    offsets: parsed.offsets,
    outputs: {
      rawJsonPath,
      normalizedJsonPath,
      screenshotPath,
    },
  }, null, 2)}\n`, "utf8");

  const manifest = buildManifest({
    normalized,
    rawJsonPath,
    normalizedJsonPath,
    summaryPath,
    xmlToSourcePath: generatedXmlToSourcePath,
    screenshotPath,
    metadataPath,
    parseMs: Date.now() - startAt,
  });
  printJson(manifest, pretty);
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
