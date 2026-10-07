/* ------------------------------------------------------------------------
 * 数学曲线加载动效 —— 粒子轨迹（rose / 七瓣花环）
 * 上游：https://github.com/Paidax01/math-curve-loaders   （original.js / original.html, main 分支）
 * 许可证：MIT   原作者：Paidax01
 *
 * 本文件由 tools/fetch-curve-loader.mjs 生成，请勿手改。
 * 生成方式：下载上游 original.js，**原样取出**它的 9 个常量与 5 个函数
 * （normalizeProgress / getPoint / buildPath / getDetailScale / getRotation /
 * getParticle），只把外面的壳换掉 —— 上游用模块级 document.querySelector 绑死
 * 单个固定 id，这里改成 PiCurve.create(host) 并让所有实例共用一条 rAF。
 * 曲线参数一个都没动：64 粒子、7 瓣、4.6s 一圈、4.2s 呼吸、28s 自转。
 *
 * 用法：PiCurve.create(document.getElementById("statusAnim"))
 *       → { destroy() }
 * ------------------------------------------------------------------------ */
(function () {
"use strict";

const PARTICLE_COUNT = 64;
const BASE_RADIUS = 7;
const PETALS = 7;
const DETAIL = 3;
const SCALE = 3.9;
const TRAIL_SPAN = 0.38;
const ROTATION_DURATION_MS = 28000;
const PULSE_DURATION_MS = 4200;
const DURATION_MS = 4600;
var STROKE_WIDTH = 5.5;

function normalizeProgress(progress) {
  return ((progress % 1) + 1) % 1;
}

function getPoint(progress, detailScale) {
  const t = normalizeProgress(progress) * Math.PI * 2;
  const x = BASE_RADIUS * Math.cos(t) - DETAIL * detailScale * Math.cos(PETALS * t);
  const y = BASE_RADIUS * Math.sin(t) - DETAIL * detailScale * Math.sin(PETALS * t);

  return {
    x: 50 + x * SCALE,
    y: 50 + y * SCALE,
  };
}

function buildPath(detailScale, steps = 360) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const point = getPoint(index / steps, detailScale);
    return `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(" ");
}

function getDetailScale(time) {
  const pulseProgress = (time % PULSE_DURATION_MS) / PULSE_DURATION_MS;
  const pulseAngle = pulseProgress * Math.PI * 2;
  return 0.5 + ((Math.sin(pulseAngle + 0.55) + 1) / 2) * 0.45;
}

function getRotation(time) {
  return -((time % ROTATION_DURATION_MS) / ROTATION_DURATION_MS) * 360;
}

function getParticle(index, progress, detailScale) {
  const tailOffset = index / (PARTICLE_COUNT - 1);
  const point = getPoint(progress - tailOffset * TRAIL_SPAN, detailScale);
  const fade = Math.pow(1 - tailOffset, 0.58);

  return {
    x: point.x,
    y: point.y,
    radius: 1.05 + fade * 2.75,
    opacity: 0.08 + fade * 0.92,
  };
}

// ---------------------------------------------------------------- 实例外壳
// 上游在一个模块里只驱动一个固定 id 的 SVG；插件里状态行动画、工具条目动画
// 都可能同时存在，所以这里按实例管理，并且**共用一条 rAF**：N 个实例也只跑
// 一个回调（上游画廊就是一个卡片一条 rAF，那是它自己的场景）。
var instances = [];
var running = false;
var SVG_NS = "http://www.w3.org/2000/svg";

function createSvg() {
  var svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  var group = document.createElementNS(SVG_NS, "g");
  var path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "trail");
  path.setAttribute("stroke-width", String(STROKE_WIDTH));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  group.appendChild(path);
  svg.appendChild(group);
  var dots = [];
  for (var i = 0; i < PARTICLE_COUNT; i++) {
    var circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", "dot");
    group.appendChild(circle);
    dots.push(circle);
  }
  return { svg: svg, group: group, path: path, dots: dots };
}

function renderInstance(instance, time) {
  var progress = (time % DURATION_MS) / DURATION_MS;
  var detailScale = getDetailScale(time);
  instance.group.setAttribute("transform", "rotate(" + getRotation(time) + " 50 50)");
  instance.path.setAttribute("d", buildPath(detailScale));
  for (var i = 0; i < instance.dots.length; i++) {
    var particle = getParticle(i, progress, detailScale);
    var node = instance.dots[i];
    node.setAttribute("cx", particle.x.toFixed(2));
    node.setAttribute("cy", particle.y.toFixed(2));
    node.setAttribute("r", particle.radius.toFixed(2));
    node.setAttribute("opacity", particle.opacity.toFixed(3));
  }
}

function tick(now) {
  for (var i = 0; i < instances.length; i++) {
    renderInstance(instances[i], now - instances[i].startedAt);
  }
  if (instances.length) requestAnimationFrame(tick);
  else running = false;
}

function start() {
  if (running) return;
  running = true;
  requestAnimationFrame(tick);
}

/**
 * 把动效挂到 host 元素里。host 里已有的内容会被清掉 —— 调用方每次重建即可，
 * 重复 create 同一个 host 不会叠加元素。
 *
 * opts.animate === false（宿主开了 prefers-reduced-motion）时**照样画第一帧**，
 * 只是不启动 rAF。页面把「减少动态效果」当成「不要这个状态指示器」是错的。
 */
function create(host, opts) {
  if (!host) return { destroy: function () {} };
  var animate = !(opts && opts.animate === false);
  var built = createSvg();
  host.textContent = "";
  host.appendChild(built.svg);
  var instance = {
    host: host,
    group: built.group,
    path: built.path,
    dots: built.dots,
    startedAt: performance.now(),
  };
  renderInstance(instance, 0);
  if (animate) {
    instances.push(instance);
    start();
  }
  return {
    destroy: function () {
      var at = instances.indexOf(instance);
      if (at !== -1) instances.splice(at, 1);
      if (built.svg.parentNode) built.svg.parentNode.removeChild(built.svg);
    },
  };
}

window.PiCurve = { create: create };
})();
