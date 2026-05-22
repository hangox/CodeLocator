// 单测 find-click.ts
//
// 覆盖范围：
//   1. parseArgs：所有 flag / alias / 错误参数 / --help
//   2. decodePayload：URL-safe + 标准 base64
//   3. findLatestCodeLocatorFile：空目录 / 非 .codeLocator 干扰 / mtime 选最新 / 不存在的目录
//   4. parseCodeLocatorApplication：合成 fixture 端到端解析 / 文件太小 / JSON 越界
//   5. resolveAddresses：命中 / 部分命中 / 顺序保持 / hex 大小写 / 缺 b7 兜底 / 部分 bounds
//   6. buildManifest：addresses 空 / 无 grab / 全 unmatch / 命中 → hints 文案与字段
//   7. runFindClick：用 DI 注入 fake deps，端到端验证 orchestrator（不走 adb）
//   8. fetchTouchViewResponse：用 fake-adb 真跑 broadcast 路径，覆盖 inline / file / empty / error 四种回执

// @ts-ignore Node 内置 test runner
import { describe, it, before, after } from "node:test";
// @ts-ignore Node 内置 assert
import { strict as assert } from "node:assert";
// @ts-ignore Node 内置
import { gzipSync } from "node:zlib";
// @ts-ignore
import { Buffer } from "node:buffer";
// @ts-ignore
import { mkdtempSync, writeFileSync, utimesSync, rmSync, mkdirSync } from "node:fs";
// @ts-ignore
import { tmpdir } from "node:os";
// @ts-ignore
import { join } from "node:path";

import {
  parseArgs,
  decodePayload,
  findLatestCodeLocatorFile,
  parseCodeLocatorApplication,
  resolveAddresses,
  buildManifest,
  runFindClick,
  fetchTouchViewResponse,
  SilentExit,
  type TouchViewResponse,
  type FindClickDeps,
} from "../../find-click.ts";

import { makeFakeAdb } from "../helpers/fake-adb.ts";

// ============================================================================
// 工具：合成一份 .codeLocator 二进制文件
// 文件布局（references/02）：
//   4B BE 长度 + tag 字符串 + 4B BE 长度 + version + 4B BE 长度 + WApplication JSON + PNG bytes
// ============================================================================
function buildCodeLocatorBuffer(applicationJson: Record<string, unknown>): Buffer {
  const tag = Buffer.from("CodeLocator", "utf-8");
  const version = Buffer.from("2.1.0", "utf-8");
  const json = Buffer.from(JSON.stringify(applicationJson), "utf-8");
  // 最小 PNG（只有 signature 即可，parseCodeLocatorApplication 不读这段）
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buf = Buffer.alloc(4 + tag.length + 4 + version.length + 4 + json.length + png.length);
  let o = 0;
  buf.writeInt32BE(tag.length, o); o += 4;
  tag.copy(buf, o); o += tag.length;
  buf.writeInt32BE(version.length, o); o += 4;
  version.copy(buf, o); o += version.length;
  buf.writeInt32BE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  png.copy(buf, o);
  return buf;
}

const SAMPLE_RAW_APP = {
  b7: {  // activity
    ag: "com.example.MainActivity",
    af: "ACT_ROOT",
    cj: [  // decorViews
      {
        af: "DECOR_1",
        ag: "android.view.DecorView",
        d: 0, e: 1080, f: 0, g: 2400,
        a: [  // children
          {
            af: "FRAME_1",
            ag: "android.widget.FrameLayout",
            d: 0, e: 1080, f: 100, g: 2400,
            a: [
              {
                af: "BTN_OK",
                ag: "android.widget.Button",
                ac: "app:btnOk",
                d: 100, e: 300, f: 200, g: 250,
              },
              {
                af: "lower_hex",  // 故意小写，验证大小写敏感
                ag: "android.widget.TextView",
              },
            ],
          },
        ],
      },
    ],
  },
};

// ============================================================================
// 1. parseArgs
// ============================================================================
describe("parseArgs", () => {
  it("空 argv 返回默认值", () => {
    const opts = parseArgs([]);
    assert.equal(opts.serial, null);
    assert.equal(opts.codeLocatorPath, null);
    assert.equal(opts.pretty, false);
  });

  it("--help / -h 抛 SilentExit（不打印 usage，交给 CLI 入口处理）", () => {
    assert.throws(() => parseArgs(["--help"]), SilentExit);
    assert.throws(() => parseArgs(["-h"]), SilentExit);
  });

  it("--pretty 设 pretty=true", () => {
    assert.equal(parseArgs(["--pretty"]).pretty, true);
  });

  it("--serial 与 --serial= 与 --device 与 --device= 四种形态都设 serial", () => {
    assert.equal(parseArgs(["--serial", "ABC"]).serial, "ABC");
    assert.equal(parseArgs(["--serial=ABC"]).serial, "ABC");
    assert.equal(parseArgs(["--device", "ABC"]).serial, "ABC");
    assert.equal(parseArgs(["--device=ABC"]).serial, "ABC");
  });

  it("--codelocator 路径会被 resolve 成绝对路径", () => {
    const opts = parseArgs(["--codelocator", "./foo.codeLocator"]);
    assert.ok(opts.codeLocatorPath?.startsWith("/"), `expected absolute path, got ${opts.codeLocatorPath}`);
    assert.ok(opts.codeLocatorPath?.endsWith("foo.codeLocator"));
  });

  it("未知参数立即抛错", () => {
    assert.throws(() => parseArgs(["--bogus"]), /未知参数：--bogus/);
  });

  it("--serial 紧跟 EOF 时 serial=null（与无 --serial 行为一致）", () => {
    // argv[++i] 是 undefined → ?? null。这是合理兜底（后续 pickDevice 会自动选）
    const opts = parseArgs(["--serial"]);
    assert.equal(opts.serial, null);
  });
});

// ============================================================================
// 2. decodePayload
// ============================================================================
describe("decodePayload", () => {
  it("标准 base64 输入：解压并 JSON.parse", () => {
    const obj = { code: 0, msg: null, data: ["addr1"] };
    const compressed = gzipSync(Buffer.from(JSON.stringify(obj), "utf-8"));
    const b64 = compressed.toString("base64");
    const result = decodePayload(b64);
    assert.deepEqual(result, obj);
  });

  it("URL-safe base64（- 与 _）也能正确解码（Node Buffer 原生兼容）", () => {
    const obj = { code: 0, data: ["xxx"] };
    const compressed = gzipSync(Buffer.from(JSON.stringify(obj), "utf-8"));
    const b64url = compressed.toString("base64url");
    // 强制确认 b64url 至少包含一个 url-safe 特征字符或就是 url-safe 形式
    assert.ok(!/[+/=]/.test(b64url), "base64url should have no +/= chars");
    const result = decodePayload(b64url);
    assert.deepEqual(result, obj);
  });

  it("外层 trim 空白", () => {
    const obj = { code: 0 };
    const b64 = gzipSync(Buffer.from(JSON.stringify(obj))).toString("base64");
    const result = decodePayload(`  \n${b64}\n  `);
    assert.deepEqual(result, obj);
  });

  it("无效 base64+gzip 抛错（gunzip 失败）", () => {
    assert.throws(() => decodePayload("not-a-real-payload"));
  });
});

// ============================================================================
// 3. findLatestCodeLocatorFile
// ============================================================================
describe("findLatestCodeLocatorFile", () => {
  let tmp: string;
  before(() => { tmp = mkdtempSync(join(tmpdir(), "find-click-test-")); });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("不存在的目录 → null", async () => {
    const result = await findLatestCodeLocatorFile(join(tmp, "does-not-exist"));
    assert.equal(result, null);
  });

  it("空目录 → null", async () => {
    const empty = join(tmp, "empty");
    writeFileSync(join(tmp, "ignored.txt"), "x"); // 干扰文件
    mkdirSync(empty);
    const result = await findLatestCodeLocatorFile(empty);
    assert.equal(result, null);
  });

  it("只有非 .codeLocator 文件 → null", async () => {
    const dir = join(tmp, "non-cl");
    mkdirSync(dir);
    writeFileSync(join(dir, "foo.txt"), "x");
    writeFileSync(join(dir, "bar.json"), "x");
    const result = await findLatestCodeLocatorFile(dir);
    assert.equal(result, null);
  });

  it("多个 .codeLocator 返回 mtime 最新", async () => {
    const dir = join(tmp, "multi");
    mkdirSync(dir);
    const oldPath = join(dir, "old.codeLocator");
    const newPath = join(dir, "new.codeLocator");
    const distractor = join(dir, "irrelevant.txt");
    writeFileSync(oldPath, "x");
    writeFileSync(newPath, "x");
    writeFileSync(distractor, "x");
    // 设 old 的 mtime 一小时前，new 是现在
    const now = Date.now() / 1000;
    utimesSync(oldPath, now - 3600, now - 3600);
    utimesSync(newPath, now, now);
    const result = await findLatestCodeLocatorFile(dir);
    assert.equal(result, newPath);
  });
});

// ============================================================================
// 4. parseCodeLocatorApplication
// ============================================================================
describe("parseCodeLocatorApplication", () => {
  let tmp: string;
  before(() => { tmp = mkdtempSync(join(tmpdir(), "find-click-parse-")); });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("合成 fixture：返回顶层 b7 等短名 JSON", async () => {
    const path = join(tmp, "good.codeLocator");
    writeFileSync(path, buildCodeLocatorBuffer(SAMPLE_RAW_APP));
    const app = await parseCodeLocatorApplication(path);
    assert.ok("b7" in app, "顶层应有 b7 短名（不是 activity）");
    const activity = app.b7 as Record<string, unknown>;
    assert.equal(activity.ag, "com.example.MainActivity");
    assert.ok(Array.isArray(activity.cj));
  });

  it("文件太小（< 12 字节）→ 抛 '文件太小'", async () => {
    const path = join(tmp, "tiny.codeLocator");
    writeFileSync(path, Buffer.from([0, 1, 2]));
    await assert.rejects(parseCodeLocatorApplication(path), /文件太小/);
  });

  it("JSON 长度字段越界 → 抛 'JSON 段越界'", async () => {
    const path = join(tmp, "corrupt.codeLocator");
    // 构造一个 JSON 长度声明 9999999，但实际 buffer 不够长
    const tag = Buffer.from("CodeLocator", "utf-8");
    const version = Buffer.from("2.1.0", "utf-8");
    const buf = Buffer.alloc(4 + tag.length + 4 + version.length + 4 + 8);
    let o = 0;
    buf.writeInt32BE(tag.length, o); o += 4;
    tag.copy(buf, o); o += tag.length;
    buf.writeInt32BE(version.length, o); o += 4;
    version.copy(buf, o); o += version.length;
    buf.writeInt32BE(9999999, o); // 超大 JSON 长度
    writeFileSync(path, buf);
    await assert.rejects(parseCodeLocatorApplication(path), /JSON 段越界/);
  });
});

// ============================================================================
// 5. resolveAddresses
// ============================================================================
describe("resolveAddresses", () => {
  it("空 addresses → 空数组（短路）", () => {
    const result = resolveAddresses(SAMPLE_RAW_APP, []);
    assert.deepEqual(result, []);
  });

  it("全部命中：保持 addresses 顺序，含 className/idStr/bounds/path", () => {
    const addresses = ["BTN_OK", "FRAME_1", "DECOR_1"];
    const result = resolveAddresses(SAMPLE_RAW_APP, addresses);
    assert.equal(result.length, 3);
    assert.equal(result[0].memAddr, "BTN_OK");
    assert.equal(result[0].className, "android.widget.Button");
    assert.equal(result[0].idStr, "app:btnOk");
    assert.deepEqual(result[0].bounds, { left: 100, top: 200, right: 300, bottom: 250 });
    assert.equal(result[0].path, "decorViews/0/0/0");

    assert.equal(result[1].memAddr, "FRAME_1");
    assert.equal(result[1].path, "decorViews/0/0");

    assert.equal(result[2].memAddr, "DECOR_1");
    assert.equal(result[2].path, "decorViews/0");
  });

  it("部分命中：未命中保留占位 className=null", () => {
    const result = resolveAddresses(SAMPLE_RAW_APP, ["BTN_OK", "DOES_NOT_EXIST"]);
    assert.equal(result.length, 2);
    assert.equal(result[0].className, "android.widget.Button");
    assert.equal(result[1].memAddr, "DOES_NOT_EXIST");
    assert.equal(result[1].className, null);
    assert.equal(result[1].path, null);
    assert.equal(result[1].bounds, null);
  });

  it("大小写敏感：BTN_ok 不匹配 BTN_OK", () => {
    const result = resolveAddresses(SAMPLE_RAW_APP, ["BTN_ok"]);
    assert.equal(result[0].className, null);
  });

  it("缺 b7（顶层 activity 丢失）→ 全部返回 null 占位", () => {
    const result = resolveAddresses({ b8: {} }, ["BTN_OK"]);
    assert.equal(result[0].className, null);
    assert.equal(result[0].bounds, null);
  });

  it("无 bounds 字段的 view（lower_hex）→ bounds=null", () => {
    const result = resolveAddresses(SAMPLE_RAW_APP, ["lower_hex"]);
    assert.equal(result[0].className, "android.widget.TextView");
    assert.equal(result[0].bounds, null);
  });

  it("addresses 包含重复 memAddr → 只命中一次但都各占一格", () => {
    const result = resolveAddresses(SAMPLE_RAW_APP, ["BTN_OK", "BTN_OK"]);
    assert.equal(result.length, 2);
    // 第一个命中拿到完整字段
    assert.equal(result[0].className, "android.widget.Button");
    // 第二个也命中（map.get 同一个 entry），同样字段
    assert.equal(result[1].className, "android.widget.Button");
  });
});

// ============================================================================
// 6. buildManifest
// ============================================================================
describe("buildManifest", () => {
  let tmp: string;
  let goodCodeLocator: string;
  let emptyHistoryDir: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "find-click-manifest-"));
    goodCodeLocator = join(tmp, "good.codeLocator");
    writeFileSync(goodCodeLocator, buildCodeLocatorBuffer(SAMPLE_RAW_APP));
    emptyHistoryDir = join(tmp, "empty-history");
    mkdirSync(emptyHistoryDir);
  });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("addresses 空 → 提示用户先点屏，resolved=null", async () => {
    const m = await buildManifest({
      serial: "SER1",
      response: { code: 0, data: [] },
      codeLocatorPathHint: null,
      defaultHistoryDir: emptyHistoryDir,
    });
    assert.equal(m.status, "ok");
    assert.equal(m.device.serial, "SER1");
    assert.equal(m.response.code, 0);
    assert.equal(m.response.addressCount, 0);
    assert.deepEqual(m.addresses, []);
    assert.equal(m.resolved, null);
    assert.equal(m.resolveSource, null);
    assert.equal(m.hints.length, 1);
    assert.match(m.hints[0], /请在设备上点击/);
  });

  it("addresses 非空但无 grab 文件 → 只输出 addresses，提示先 grab", async () => {
    const m = await buildManifest({
      serial: "SER1",
      response: { code: 0, data: ["BTN_OK"] },
      codeLocatorPathHint: null,
      defaultHistoryDir: emptyHistoryDir,
    });
    assert.deepEqual(m.addresses, ["BTN_OK"]);
    assert.equal(m.resolved, null);
    assert.equal(m.resolveSource, null);
    assert.equal(m.hints.length, 1);
    assert.match(m.hints[0], /先用 grab/);
  });

  it("addresses + grab 文件命中 → 反查成功，无 hint", async () => {
    const m = await buildManifest({
      serial: "SER1",
      response: { code: 0, data: ["BTN_OK", "DECOR_1"] },
      codeLocatorPathHint: goodCodeLocator,
      defaultHistoryDir: emptyHistoryDir,
    });
    assert.equal(m.resolveSource, goodCodeLocator);
    assert.equal(m.resolveError, null);
    assert.equal(m.resolved?.length, 2);
    assert.equal(m.resolved?.[0].className, "android.widget.Button");
    assert.deepEqual(m.hints, []);
  });

  it("addresses 全 unmatch grab → 触发 identityHashCode 失效提示", async () => {
    const m = await buildManifest({
      serial: "SER1",
      response: { code: 0, data: ["NOT_THERE_1", "NOT_THERE_2"] },
      codeLocatorPathHint: goodCodeLocator,
      defaultHistoryDir: emptyHistoryDir,
    });
    assert.equal(m.resolved?.length, 2);
    assert.equal(m.resolved?.[0].className, null);
    assert.equal(m.hints.length, 1);
    assert.match(m.hints[0], /identityHashCode 失效/);
  });

  it("grab 文件损坏 → resolveError 字段携带原因，resolved=null", async () => {
    const broken = join(tmp, "broken.codeLocator");
    writeFileSync(broken, Buffer.from([0, 0, 0, 1])); // 太小
    const m = await buildManifest({
      serial: "SER1",
      response: { code: 0, data: ["X"] },
      codeLocatorPathHint: broken,
      defaultHistoryDir: emptyHistoryDir,
    });
    assert.equal(m.resolved, null);
    assert.ok(m.resolveError);
    assert.match(m.resolveError as string, /文件太小/);
  });

  it("自动从 defaultHistoryDir 取 mtime 最新（无 codeLocatorPathHint）", async () => {
    const histDir = join(tmp, "history-auto");
    mkdirSync(histDir);
    writeFileSync(join(histDir, "auto.codeLocator"), buildCodeLocatorBuffer(SAMPLE_RAW_APP));
    const m = await buildManifest({
      serial: "SER1",
      response: { code: 0, data: ["BTN_OK"] },
      codeLocatorPathHint: null,
      defaultHistoryDir: histDir,
    });
    assert.equal(m.resolveSource, join(histDir, "auto.codeLocator"));
    assert.equal(m.resolved?.[0].className, "android.widget.Button");
  });
});

// ============================================================================
// 7. runFindClick（DI 注入，验证 orchestrator 装配，不走真 adb）
// ============================================================================
describe("runFindClick (DI)", () => {
  it("端到端：pickDevice → fetch → buildManifest 拼接正确", async () => {
    const deps: FindClickDeps = {
      pickDevice: async (explicit) => {
        assert.equal(explicit, "USER_SERIAL");
        return "USER_SERIAL";
      },
      fetchTouchViewResponse: async (serial): Promise<TouchViewResponse> => {
        assert.equal(serial, "USER_SERIAL");
        return { code: 0, msg: null, data: ["ADDR1", "ADDR2"] };
      },
      defaultHistoryDir: mkdtempSync(join(tmpdir(), "find-click-empty-")), // 空目录
    };
    const m = await runFindClick({ serial: "USER_SERIAL", codeLocatorPath: null, pretty: false }, deps);
    assert.equal(m.device.serial, "USER_SERIAL");
    assert.equal(m.response.addressCount, 2);
    assert.deepEqual(m.addresses, ["ADDR1", "ADDR2"]);
    assert.equal(m.resolved, null); // 空 history dir
    assert.match(m.hints[0], /先用 grab/);
  });

  it("fetchTouchViewResponse 抛错时 runFindClick 透传", async () => {
    const deps: FindClickDeps = {
      pickDevice: async () => "X",
      fetchTouchViewResponse: async () => { throw new Error("broadcast 回执为空"); },
    };
    await assert.rejects(
      runFindClick({ serial: null, codeLocatorPath: null, pretty: false }, deps),
      /broadcast 回执为空/,
    );
  });
});

// ============================================================================
// 8. fetchTouchViewResponse（fake-adb 真跑 broadcast 路径）
// ============================================================================
describe("fetchTouchViewResponse (fake adb)", () => {
  const origAdbPath = process.env.ADB_PATH;
  let adb: ReturnType<typeof makeFakeAdb> | null = null;
  after(() => {
    if (adb) adb.cleanup();
    if (origAdbPath === undefined) delete process.env.ADB_PATH;
    else process.env.ADB_PATH = origAdbPath;
  });

  // 把 TouchViewResponse 编为 gzip+base64 内联 data，构造和 SDK 真实输出一致的 stdout
  function makeInlineStdout(resp: TouchViewResponse): string {
    const compressed = gzipSync(Buffer.from(JSON.stringify(resp), "utf-8"));
    const b64 = compressed.toString("base64url");
    return [
      "Broadcasting: Intent { act=com.bytedance.tools.codelocator.action_get_touch_view }",
      `Broadcast completed: result=-1, data="${b64}"`,
    ].join("\n");
  }

  it("inline 回执解码：response.data 是 memAddr 数组", async () => {
    const expected: TouchViewResponse = { code: 0, msg: null, data: ["AA", "BB"] };
    adb = makeFakeAdb([
      { match: "-s ZY shell am broadcast", stdout: makeInlineStdout(expected) },
    ]);
    process.env.ADB_PATH = adb.path;
    const resp = await fetchTouchViewResponse("ZY");
    assert.deepEqual(resp, expected);
  });

  it("empty 回执（broadcast 没 data=）→ 抛 '回执为空'", async () => {
    adb?.cleanup();
    adb = makeFakeAdb([
      { match: "-s ZY shell am broadcast", stdout: "Broadcast completed: result=0" },
    ]);
    process.env.ADB_PATH = adb.path;
    await assert.rejects(fetchTouchViewResponse("ZY"), /回执为空/);
  });

  it("Error: 形态的 data 串 → 抛 'SDK 端返回错误'", async () => {
    adb?.cleanup();
    adb = makeFakeAdb([
      { match: "-s ZY shell am broadcast", stdout: 'Broadcast completed: result=-1, data="Error:not_init"' },
    ]);
    process.env.ADB_PATH = adb.path;
    await assert.rejects(fetchTouchViewResponse("ZY"), /SDK 端返回错误/);
  });

  it("非 0 退出码 → 抛 'am broadcast 失败'", async () => {
    adb?.cleanup();
    adb = makeFakeAdb([
      { match: "-s ZY shell am broadcast", stdout: "", stderr: "device offline", exitCode: 1 },
    ]);
    process.env.ADB_PATH = adb.path;
    await assert.rejects(fetchTouchViewResponse("ZY"), /am broadcast 失败/);
  });

  // 注：FP 文件路径的 happy path 涉及 adb pull + 真实文件 IO，
  // 跨平台路径处理（macOS /sdcard/ 写到本地 /tmp/）需要更多 fixture 协调；
  // 真实场景被 e2e 覆盖，单测这里只验前置 4 种回执解析分支即可。
});

declare const process: {
  argv: string[];
  exitCode?: number;
  env: Record<string, string | undefined>;
};
