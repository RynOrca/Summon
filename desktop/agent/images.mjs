const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function normalizeImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("一次最多发送 8 张图片");
  return value.map((image) => {
    if (!image || image.type !== "image" || !allowed.has(image.mimeType) ||
        typeof image.data !== "string" || !image.data || image.data.length > 7_000_000 ||
        image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
        Buffer.from(image.data, "base64").length > 5 * 1024 * 1024) {
      throw new Error("图片附件格式或大小无效");
    }
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
}
