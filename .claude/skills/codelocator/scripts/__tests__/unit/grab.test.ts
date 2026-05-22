// grab.test.ts
// 覆盖 grab.ts 的纯逻辑：
//   - buildCodeLocatorFile：二进制布局（4-byte BE prefix × 3 + png bytes）与 CodeLocatorInfo.toBytes 对齐
//   - buildHistoryFileName：`<pkg><yyyy_MM_dd_HH_mm_ss>.codeLocator`
//   - packageFromResumed：dumpsys 输出拆 pkg
//   - decodePayload / extractApplicationJson：协议解码闭环
//   - parseArgs：CLI 选项解析（--need-color、--device、--no-foreground-check、未知参数）

// @ts-ignore Node 内置
import { test } from "node:test";
// @ts-ignore Node 内置
import { strict as assert } from "node:assert";
// @ts-ignore Node 内置
import { gzipSync } from "node:zlib";
// @ts-ignore Node 内置
import { Buffer } from "node:buffer";

import {
  buildCodeLocatorFile,
  buildHistoryFileName,
  packageFromResumed,
  decodePayload,
  extractApplicationJson,
  parseArgs,
  GrabError,
} from "../../grab.ts";

test("buildCodeLocatorFile: 严格遵循 CodeLocatorInfo.toBytes 二进制布局", () => {
  const appJson = '{"bd":"com.foo","b7":{"ag":"com.foo.MainActivity"}}';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic 头 8 字节
  const version = "1.2.3";
  const out = buildCodeLocatorFile(appJson, png, version);

  const buf = Buffer.from(out);
  let offset = 0;
  const tagLen = buf.readInt32BE(offset); offset += 4;
  assert.equal(tagLen, "CodeLocator".length);
  assert.equal(buf.toString("utf-8", offset, offset + tagLen), "CodeLocator");
  offset += tagLen;

  const verLen = buf.readInt32BE(offset); offset += 4;
  assert.equal(verLen, Buffer.byteLength(version, "utf-8"));
  assert.equal(buf.toString("utf-8", offset, offset + verLen), version);
  offset += verLen;

  const jsonLen = buf.readInt32BE(offset); offset += 4;
  assert.equal(jsonLen, Buffer.byteLength(appJson, "utf-8"));
  assert.equal(buf.toString("utf-8", offset, offset + jsonLen), appJson);
  offset += jsonLen;

  // 剩余字节应等于 png 原文
  assert.equal(buf.length - offset, png.length);
  for (let i = 0; i < png.length; i += 1) {
    assert.equal(buf[offset + i], png[i]);
  }
});

test("buildCodeLocatorFile: 中文 appJson 的 UTF-8 字节长度按 Buffer.byteLength 算", () => {
  const appJson = JSON.stringify({ ag: "中文应用类名", text: "你好" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const out = buildCodeLocatorFile(appJson, png, "v1");
  const buf = Buffer.from(out);

  // 跳过 tag + version 段
  let offset = 4 + "CodeLocator".length + 4 + "v1".length;
  const jsonLen = buf.readInt32BE(offset); offset += 4;
  // UTF-8 编码后的字节数应该 > 字符串字符数（含中文）
  assert.ok(jsonLen > appJson.length, "UTF-8 编码后字节数 > 字符数");
  assert.equal(jsonLen, Buffer.byteLength(appJson, "utf-8"));
  assert.equal(buf.toString("utf-8", offset, offset + jsonLen), appJson);
});

test("buildHistoryFileName: 文件名格式与 ShowGrabHistoryAction 对齐", () => {
  // 2026-05-21 14:30:05
  const when = new Date(2026, 4, 21, 14, 30, 5);
  const name = buildHistoryFileName("com.foo.bar", when);
  assert.equal(name, "com.foo.bar2026_05_21_14_30_05.codeLocator");
});

test("buildHistoryFileName: 单位数补零", () => {
  const when = new Date(2026, 0, 1, 1, 2, 3);
  const name = buildHistoryFileName("p", when);
  assert.equal(name, "p2026_01_01_01_02_03.codeLocator");
});

test("packageFromResumed: 标准形态", () => {
  assert.equal(packageFromResumed("com.foo.bar/.MainActivity"), "com.foo.bar");
  assert.equal(packageFromResumed("a.b/c.d"), "a.b");
});

test("packageFromResumed: null / 无 / 边界", () => {
  assert.equal(packageFromResumed(null), null);
  assert.equal(packageFromResumed("nosurfix"), null);
  assert.equal(packageFromResumed("/leadingslash"), null);
});

test("decodePayload: base64(gzip(json)) → json", () => {
  const json = '{"code":0,"data":{"ag":"foo"}}';
  const compressed = gzipSync(Buffer.from(json, "utf-8"));
  const b64 = compressed.toString("base64");
  assert.equal(decodePayload(b64), json);
});

test("extractApplicationJson: 从 BaseResponse 抽出 data 并 stringify", () => {
  const baseResponse = JSON.stringify({ code: 0, data: { ag: "com.foo.App", bd: "com.foo" } });
  const appJson = extractApplicationJson(baseResponse);
  assert.deepEqual(JSON.parse(appJson), { ag: "com.foo.App", bd: "com.foo" });
});

test("extractApplicationJson: code != 0 且无 data → 抛 SDK_ERROR", () => {
  const baseResponse = JSON.stringify({ code: -1, msg: "no_current_activity" });
  assert.throws(
    () => extractApplicationJson(baseResponse),
    (e: unknown) => {
      assert.ok(e instanceof GrabError);
      assert.equal((e as GrabError).code, "SDK_ERROR");
      return true;
    },
  );
});

test("extractApplicationJson: data 为 null → 抛 SDK_EMPTY_DATA", () => {
  const baseResponse = JSON.stringify({ code: 0, data: null, msg: "" });
  assert.throws(
    () => extractApplicationJson(baseResponse),
    (e: unknown) => {
      assert.ok(e instanceof GrabError);
      assert.equal((e as GrabError).code, "SDK_EMPTY_DATA");
      return true;
    },
  );
});

test("parseArgs: 默认值", () => {
  const opts = parseArgs([]);
  assert.equal(opts.device, null);
  assert.equal(opts.packageFilter, null);
  assert.equal(opts.skipForegroundCheck, false);
  assert.equal(opts.needColor, false);
  assert.equal(opts.pretty, false);
  assert.equal(opts.help, false);
  assert.ok(opts.outputDir.endsWith("/.codeLocator_main/historyFile"));
});

test("parseArgs: --device --package --need-color --no-foreground-check --pretty", () => {
  const opts = parseArgs([
    "--device", "SERIAL1",
    "--package", "com.foo",
    "--need-color",
    "--no-foreground-check",
    "--pretty",
  ]);
  assert.equal(opts.device, "SERIAL1");
  assert.equal(opts.packageFilter, "com.foo");
  assert.equal(opts.needColor, true);
  assert.equal(opts.skipForegroundCheck, true);
  assert.equal(opts.pretty, true);
});

test("parseArgs: 长等号形态 --device=SERIAL", () => {
  const opts = parseArgs(["--device=A", "--package=com.b", "--output-dir=/tmp/x"]);
  assert.equal(opts.device, "A");
  assert.equal(opts.packageFilter, "com.b");
  assert.equal(opts.outputDir, "/tmp/x");
});

test("parseArgs: 未知参数抛 UNKNOWN_OPTION", () => {
  assert.throws(
    () => parseArgs(["--lol"]),
    (e: unknown) => {
      assert.ok(e instanceof GrabError);
      assert.equal((e as GrabError).code, "UNKNOWN_OPTION");
      return true;
    },
  );
});

test("parseArgs: 缺失参数值抛 MISSING_ARG", () => {
  assert.throws(
    () => parseArgs(["--device"]),
    (e: unknown) => {
      assert.ok(e instanceof GrabError);
      assert.equal((e as GrabError).code, "MISSING_ARG");
      return true;
    },
  );
});
