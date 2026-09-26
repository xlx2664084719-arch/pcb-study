// gerber2png — 把 Gerber 渲染成 PNG（作品集配图就是它生成的）
// 兼容 Altium 与嘉立创EDA 两种导出风格（坐标 4:4 / 4:5、G 码位置、钻孔小数点写法）
//
// 用法（按文件路径给，最通用）：
//   node gerber2png.mjs --out 顶层.png --copper Gerber_TopLayer.GTL \
//                       --gko Gerber_BoardOutlineLayer.GKO --drill Drill_PTH_Through.DRL
//
//   node gerber2png.mjs --out 顶层装配视图.png --copper ...GTL --silk ...GTO \
//                       --gko ...GKO --drill ...DRL --color "#e84c34" --assembly
//
//   node gerber2png.mjs --out L3电源平面.png --copper ...GP2 --gko ...GKO --negative
//
// 参数：
//   --copper    要渲染的铜层（顶层/底层/内电层）
//   --gko       板框层：用作画布范围与板框描边（省略则按铜层范围自适应）
//   --silk      丝印层（--assembly 时叠加；也可单独指定）
//   --drill     钻孔文件（Excellon）：画成黑孔，两种格式都认
//   --color     铜层颜色 #rrggbb（默认顶层红）
//   --negative  负片内电层：先整板铺满，再把 dark 图形当"挖空"擦掉
//   --pullback  负片距板边的内缩量 mm（默认 0.5，AD 的平面 pullback）
//   --assembly  装配视图：铜 + 丝印 + 板框 + 钻孔
//   --mm        分辨率 px/mm（默认 24）
//   --ss        超采样倍数，抗锯齿（默认 2）
import fs from 'fs';
import path from 'path';
import { parseGerber, Canvas, blend, writePNG } from './gr.mjs';

const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf('--' + k); return i < 0 ? d : (A[i + 1] === undefined || A[i + 1].startsWith('--') ? true : A[i + 1]); };
const has = (k) => A.includes('--' + k);
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const read = (p) => fs.readFileSync(p, 'latin1');

const copper = get('copper');
const out = get('out');
if (!copper || !out) { console.error('缺少 --copper / --out，见文件头用法'); process.exit(1); }
const MM = parseFloat(get('mm', 24));
const SS = parseInt(get('ss', 2));
const BG = hex(get('bg', '#0b1220'));
const gkoFile = get('gko');
const silkFile = get('silk');
const drillFile = get('drill');
const assembly = has('assembly');
const C_EDGE = [240, 200, 120], C_SILK = [226, 236, 245], C_HOLE = [18, 26, 40];

// 画布范围：优先用板框层，否则按铜层范围外扩 2.2mm
const gkoOps = gkoFile ? parseGerber(read(gkoFile)).ops : null;
const copperOps = parseGerber(read(copper)).ops;
function extents(opsLists) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const put = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const ops of opsLists) {
    if (!ops) continue;
    for (const o of ops) {
      if (o.k === 'draw') for (const p of o.pts) put(p[0], p[1]);
      else if (o.k === 'flash') put(o.x, o.y);
      else if (o.k === 'region') for (const c of o.contours) for (const p of c) put(p[0], p[1]);
    }
  }
  return { minX, maxX, minY, maxY };
}
let rect = extents([gkoOps ? gkoOps : copperOps]);   // 有板框就以板框定画面（超出板框的焊盘靠留白容纳）
const M = 2.2;
const mk = (ops, color, alpha) => { const c = new Canvas(rect.minX - M, rect.maxX + M, rect.minY - M, rect.maxY + M, MM, SS); c.paint(ops); return c.toRGBA(color, alpha ? { alpha } : {}); };

// 钻孔（Excellon）：AD 是定点整数（;;FILE_FORMAT=4:4），嘉立创EDA 带小数点
function holes() {
  if (!drillFile || !fs.existsSync(drillFile)) return [];
  const t = read(drillFile);
  const dec = +(((t.match(/;FILE_FORMAT=(\d+):(\d+)/) || [])[2]) || ((t.match(/,(?:LZ|TZ),(\d+)\.(\d+)/) || [])[2]) || 4);
  const num = (s) => (s.includes('.') ? parseFloat(s) : (+s) / Math.pow(10, dec));
  const tools = new Map(); const list = []; let cur = null;
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    const m = s.match(/^T(\d+)C([\d.]+)/); if (m) { tools.set(+m[1], parseFloat(m[2])); continue; }
    const sel = s.match(/^T(\d+)$/); if (sel) { cur = tools.get(+sel[1]); continue; }
    if (/^[XY]/.test(s)) {
      const mx = s.match(/X(-?[\d.]+)/), my = s.match(/Y(-?[\d.]+)/);
      if (mx || my) list.push({ x: mx ? num(mx[1]) : 0, y: my ? num(my[1]) : 0, d: cur });
    }
  }
  return list;
}
const drill = holes();

if (assembly) {
  const base = mk(copperOps, hex(get('color', '#e84c34')));
  const layers = [base];
  if (silkFile) layers.push(mk(parseGerber(read(silkFile)).ops, C_SILK, 235));
  if (gkoOps) layers.push(mk(gkoOps, C_EDGE));
  if (drill.length) {
    const hc = new Canvas(rect.minX - M, rect.maxX + M, rect.minY - M, rect.maxY + M, MM, SS);
    for (const h of drill) if (h.d) hc.circle(h.x, h.y, h.d / 2, 1);
    layers.push(hc.toRGBA(C_HOLE));
  }
  const img = blend(base.w, base.h, layers);
  console.log(out + '  ' + img.w + 'x' + img.h + '  ' + (writePNG(out, img, BG) / 1024).toFixed(0) + ' KB  (装配视图' + layers.length + ' 层)');
} else {
  const c = new Canvas(rect.minX - M, rect.maxX + M, rect.minY - M, rect.maxY + M, MM, SS);
  if (has('negative')) {
    const d = parseFloat(get('pullback', 0.5));
    c.poly([[[rect.minX + d, rect.minY + d], [rect.maxX - d, rect.minY + d], [rect.maxX - d, rect.maxY - d], [rect.minX + d, rect.maxY - d]]], 1);
    c.paint(copperOps, 1);                     // 负片：dark 即"挖空"
  } else c.paint(copperOps);
  const base = c.toRGBA(hex(get('color', '#e84c34')));
  const layers = [base];
  if (gkoOps) layers.push(mk(gkoOps, C_EDGE));
  const img = blend(base.w, base.h, layers);
  console.log(out + '  ' + img.w + 'x' + img.h + '  ' + (writePNG(out, img, BG) / 1024).toFixed(0) + ' KB');
}
