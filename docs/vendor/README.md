# 第三方动效（vendored）

这两个文件**不是**手写的，也不该手改 —— 各自顶部都写明了生成所用的脚本：

| 文件 | 上游 | 许可证 | 生成脚本 |
|---|---|---|---|
| `morphicons.js` | [guillermolg00/morphicons](https://github.com/guillermolg00/morphicons) v1.7.1 | MIT | `tools/fetch-morphicons.mjs` |
| `curve-loader.js` | [Paidax01/math-curve-loaders](https://github.com/Paidax01/math-curve-loaders)（`original.js` / `original.html`） | MIT | `tools/fetch-curve-loader.mjs` |

```bash
node tools/fetch-morphicons.mjs      # 重新拉取并重新拼接
node tools/fetch-curve-loader.mjs    # 重新下载并重新拼接
```

## 为什么是内联

宿主只把 `manifest.ui.panel` 那**一个** HTML 当 sandboxed 页面发出去，页面没有别的
资源通道（没有 `fs`、没有自定义协议、`net.fetch` 也不是给渲染进程加载脚本用的）。
所以第三方代码只能内联进 `renderer/index.html`，由 `tools/build-renderer.mjs` 把
`__VENDOR_JS__` 占位符替换掉。

## 改了什么

**morphicons**：只做了「ESM → 经典脚本」的机械转换。npm 包的 `dist/` 是多个 chunk
互相 `import`，页面里没有模块加载器，所以生成脚本按依赖顺序把 `morphicons/dom`
依赖的三个 chunk 拼起来、去掉 `import` / `export`（都在同一个 IIFE 作用域内，
标识符照样解析得到），最后只暴露 `window.PiMorph`。**算法与常量一字未改。**

**curve-loader**：曲线本体（9 个常量 + 6 个函数）是从上游文件里**原样取出**的，
生成脚本不重新抄写。换掉的只有外壳：

| 上游 | 这里 |
|---|---|
| 模块级 `document.querySelector("#rotating-group")`，一个文件只驱动一个固定 id | `PiCurve.create(host)`，按实例管理 |
| 每个画廊卡片各自一条 rAF | 所有实例共用一条 rAF |
| `stroke-width` 写在 `original.html` 的 `<svg>` 上 | 提出来成 `STROKE_WIDTH = 5.5` 常量（值相同） |

曲线参数（64 粒子、7 瓣、4.6s 一圈、4.2s 呼吸、28s 自转）与上游完全一致 ——
选它的理由就是这套节奏，改参数等于不用它。

## 为什么值得引入

设计基座自带的状态指示器是 `.statusline .spin`：一个 **0.8s 转一圈**的圆环边框。
用户反馈「动效速度太快了」。曲线加载器的节奏是 4.6s 一圈 + 缓慢呼吸 + 28s 自转，
观感是「流动」而不是「打转」。

`morphicons` 用在同一件事上：图标**形变**（Menu↔X、Send↔Stop、chevron 翻转）
而不是淡入淡出。它要求路径是**描边**几何（`fill="none"` + `stroke`），
而设计源包的 22 个图标都是填充型，所以这几个位置在模板里手写了描边图标对
（`docs/design-spec.md` 的图标清单之外，属于本插件新增的动效资产）。
