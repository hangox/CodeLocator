// codec.test.ts
// 覆盖：encodeShellArgs / decodeShellArgs / parseBroadcastResult / pickProviderField
// 全是纯函数，不需要 mock 任何东西。

// @ts-ignore Node 内置
import { test } from "node:test";
// @ts-ignore Node 内置
import { strict as assert } from "node:assert";
// @ts-ignore Node 内置
import { gzipSync } from "node:zlib";
// @ts-ignore Node 内置
import { Buffer } from "node:buffer";

import {
  encodeShellArgs,
  decodeShellArgs,
  parseBroadcastResult,
  pickProviderField,
} from "../../shared/codec.ts";

test("encodeShellArgs: 输出严格满足 base64url 字符集（无 + / =）", () => {
  // 选一组容易撞 + / 的 payload（含中文 + 反斜杠 + 控制字符）
  const args = {
    codeLocator_change_view: JSON.stringify({
      type: "V",
      itemId: -1782345678,
      dataList: [{ type: "T", value: "中文测试@!#" }],
    }),
  };
  const encoded = encodeShellArgs(args);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/u, `期望纯 A-Za-z0-9_-，实际：${encoded}`);
  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);
  assert.equal(encoded.includes("="), false);
});

test("encodeShellArgs: 所有值统一转字符串（对齐 Java HashMap<String, String>）", () => {
  const encoded = encodeShellArgs({ a: true, b: 42, c: "hello" });
  const decoded = decodeShellArgs(encoded);
  assert.equal(decoded.a, "true");
  assert.equal(decoded.b, "42");
  assert.equal(decoded.c, "hello");
});

test("encodeShellArgs ↔ decodeShellArgs：含特殊字符的 roundtrip 字符级相等", () => {
  const cases: Record<string, string>[] = [
    { simple: "hello" },
    { unicode: "中文 / 日本語 / 한국어 / 🎉" },
    { uriLike: "snssdk1128://feed?tab_id=1&from=push" },
    { jsonInJson: JSON.stringify({ a: 1, b: "中文 +/=value", c: [1, 2, 3] }) },
    { whitespace: "  leading and trailing  \n\t" },
  ];
  for (const c of cases) {
    const decoded = decodeShellArgs(encodeShellArgs(c));
    assert.deepEqual(decoded, c, `roundtrip 失败：${JSON.stringify(c)}`);
  }
});

test("decodeShellArgs：拒绝非对象（数组 / 标量）", () => {
  // 直接构造一个数组的 base64url
  const arrJson = JSON.stringify([1, 2, 3]);
  const b64 = Buffer.from(arrJson, "utf-8").toString("base64url");
  assert.throws(() => decodeShellArgs(b64), /not a JSON object/u);
});

test("parseBroadcastResult: file 形态 → kind=file，path 去引号去控制字符", () => {
  const stdout =
    'Broadcasting: Intent { act=foo }\n' +
    'Broadcast completed: result=-1, data="FP:/sdcard/codeLocator/x.txt"';
  const r = parseBroadcastResult(stdout);
  assert.equal(r.kind, "file");
  if (r.kind === "file") {
    assert.equal(r.path, "/sdcard/codeLocator/x.txt");
  }
});

test("parseBroadcastResult: inline 形态 → kind=inline，data 为原始 base64 串", () => {
  // 模拟 SDK 端 GZIP+base64 后塞进 data
  const fakePayload = JSON.stringify({ code: 0, data: { ag: "com.foo.App" } });
  const compressed = gzipSync(Buffer.from(fakePayload, "utf-8"));
  const b64 = compressed.toString("base64");
  const stdout = `Broadcast completed: result=-1, data="${b64}"`;
  const r = parseBroadcastResult(stdout);
  assert.equal(r.kind, "inline");
  if (r.kind === "inline") {
    assert.equal(r.data, b64);
  }
});

test("parseBroadcastResult: empty 形态（无 data= 字段）", () => {
  const stdout = "Broadcasting: Intent { act=foo }\nBroadcast completed: result=0";
  const r = parseBroadcastResult(stdout);
  assert.equal(r.kind, "empty");
});

test("parseBroadcastResult: error 形态（显式 Error: 前缀）", () => {
  const stdout = 'Broadcast completed: result=-1, data="Error:no_current_activity"';
  const r = parseBroadcastResult(stdout);
  assert.equal(r.kind, "error");
  if (r.kind === "error") {
    assert.equal(r.message, "no_current_activity");
  }
});

test("parseBroadcastResult: FP 优先于 inline（即 data 字段同时含 FP 时归类 file）", () => {
  // 这种 stdout 不会真实出现，但策略上 FP 检测在前；明确这一行为
  const stdout = 'Broadcast completed: result=-1, data="FP:/sdcard/x"';
  const r = parseBroadcastResult(stdout);
  assert.equal(r.kind, "file");
});

test("pickProviderField: 单列匹配", () => {
  const content = "Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=true, AsyncResult=FP:/sdcard/x";
  assert.equal(pickProviderField(content, "CodeLocatorVersion"), "2.1.0");
  assert.equal(pickProviderField(content, "AsyncBroadcast"), "true");
  assert.equal(pickProviderField(content, "AsyncResult"), "FP:/sdcard/x");
});

test("pickProviderField: 空值（key= 后无字符）", () => {
  const content = "Row: 0 CodeLocatorVersion=2.1.0, AsyncBroadcast=false, AsyncResult=";
  assert.equal(pickProviderField(content, "AsyncResult"), "");
});

test("pickProviderField: key 不存在 → 空串", () => {
  const content = "Row: 0 CodeLocatorVersion=2.1.0";
  assert.equal(pickProviderField(content, "NotExist"), "");
});
