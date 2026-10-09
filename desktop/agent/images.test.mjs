import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImages } from "./images.mjs";

test("图片仅接受受支持格式、有效 base64 和数量上限", () => {
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  assert.deepEqual(normalizeImages([image]), [image]);
  assert.deepEqual(normalizeImages(undefined), []);
  assert.throws(() => normalizeImages([image, ...Array(8).fill(image)]), /最多/);
  assert.throws(() => normalizeImages([{ ...image, mimeType: "image/svg+xml" }]), /格式/);
  assert.throws(() => normalizeImages([{ ...image, data: "not base64" }]), /格式/);
  assert.throws(() => normalizeImages([{ ...image, data: "A".repeat(7_000_004) }]), /格式/);
});
