// Gerber (RS-274X) 光栅化：把 AD 出的 .GTL/.GBL/.GP1/.GP2/.GTO/.GKO 渲染成 PNG
// 支持的子集：FS 4:4 绝对坐标 / MOMM / G01 G02 G03 G36 G37 G75 / D01 D02 D03 / LPD LPC /
//             光圈 C R O / 光圈宏 primitive 7(thermal) 1(circle) 21(center-line rect)
import fs from 'fs';
import zlib from 'zlib';

export function parseGerber(text) {
  const lines = text.split(/\r?\n/);
  const aps = new Map();
  const macros = new Map();
  const ops = [];
  let intr = 4, dec = 4, scale = 1e4;
  let pol = 1;            // 1=dark(画铜) 0=clear(挖空)
  let interp = 1;         // 1 线性, 2 顺时针, 3 逆时针
  let cur = null;         // 当前光圈 {type, params, macro}
  let X = 0, Y = 0;
  let region = null;      // {contours:[[..]], cur:[..]}
  let pend = 0;           // 待执行的 D 码
  let inMacro = null;

  const num = (s) => s === undefined ? NaN : parseFloat(s);
  const mm = (v) => v / scale;

  for (let raw of lines) {
    let s = raw.trim();
    if (!s) continue;
    if (inMacro) {                                  // 光圈宏体
      if (s.startsWith('%')) { inMacro = null; continue; }
      const body = s.replace(/\*$/, '');
      if (body) {
        const p = body.split(',').map(x => x.trim());
        // AD 实测格式：7,曝光,0,外径,内径,缺口,旋转   （AD 的 AMPARAMS XSize = 外径）
        if (p[0] === '7' && p.length >= 7) {
          macros.get(inMacro).push({ k: 'thermal', exp: +p[1], x: 0, y: 0, outer: parseFloat(p[3]), inner: parseFloat(p[4]), gap: parseFloat(p[5]), rot: parseFloat(p[6]) });
        } else if (p[0] === '1' && p.length >= 6) { // 圆
          macros.get(inMacro).push({ k: 'circle', exp: +p[1], x: num(p[2]), y: num(p[3]), d: parseFloat(p[4]) });
        } else if (p[0] === '21' && p.length >= 8) {// 中心线矩形
          macros.get(inMacro).push({ k: 'clrect', exp: +p[1], x: num(p[2]), y: num(p[3]), w: parseFloat(p[4]), h: parseFloat(p[5]), rot: parseFloat(p[6]) });
        } else {
          macros.get(inMacro).push({ k: 'unsupported', prim: p[0] });
        }
      }
      continue;
    }
    if (s.startsWith('%AM')) {                      // 宏定义开始
      const name = s.slice(3).replace(/\*?%?$/, '').replace(/\*$/, '');
      macros.set(name, []);
      inMacro = name;
      if (s.endsWith('%')) inMacro = null;          // 单行宏
      continue;
    }
    if (s.startsWith('%')) {                        // 扩展命令
      const body = s.replace(/^%/, '').replace(/%$/, '').replace(/\*$/, '');
      if (body.startsWith('FS')) {
        const m = body.match(/FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/);
        if (m) { intr = +m[3]; dec = +m[4]; scale = Math.pow(10, dec); }
      } else if (body.startsWith('ADD')) {
        const m = body.match(/^ADD(\d+)([A-Za-z_0-9]+)(?:,(.*))?$/);
        if (m) {
          const code = +m[1], type = m[2], par = m[3] ? m[3].split('X').map(Number) : [];
          if (macros.has(type)) aps.set(code, { type: 'MACRO', macro: type, macroBody: macros.get(type) });
          else aps.set(code, { type, params: par });
        }
      } else if (body.startsWith('LP')) {
        pol = body[2] === 'D' ? 1 : 0;
      }
      continue;
    }
    // 普通命令
    for (const cmd of s.split('*')) {
      let c = cmd.trim();
      if (!c) continue;
      // 允许 G 码和坐标写在同一行（嘉立创EDA 输出 "G01X..Y..D01*" / "G54D10*"）
      // 注意：数字要整段匹配，否则 "G36" 会被误读成 G3 + "6"（区域指令就丢了）
      let mg;
      while ((mg = c.match(/^G(\d+)(.*)$/))) {
        const code = +mg[1];                    // "01" 与 "1" 等价
        if (![1, 2, 3, 54, 70, 71, 74, 75, 90, 91].includes(code)) break;
        const rest = mg[2].trim();
        if (!rest) break;                       // 只有 G 码本身 → 交给后面的分支处理
        if (code <= 3) interp = code;
        c = rest;
      }
      if (!c) continue;
      if (/^G0?4/.test(c)) continue;                        // 注释
      if (/^G75$/.test(c) || /^G74$/.test(c)) continue;
      if (/^G7[01]$/.test(c)) continue;
      if (/^M0?2$/.test(c)) { flushRegion(); continue; }
      if (/^G36$/.test(c)) { region = { contours: [], cur: null }; continue; }
      if (/^G37$/.test(c)) { flushRegion(); continue; }
      const g = c.match(/^G0?([123])$/);
      if (g) { interp = +g[1]; continue; }
      const dsel = c.match(/^D(\d+)$/);
      if (dsel) {
        const n = +dsel[1];
        if (n >= 10) { cur = aps.get(n) || null; if (!cur) throw new Error('未定义光圈 D' + n); }
        else { pend = n; applyOp(n, { nx: X, ny: Y }); }   // 单独 D01/D02/D03：用当前点（模态）
        continue;
      }
      const co = c.match(/^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?(?:D0?([123]))?$/);
      if (co && (co[1] !== undefined || co[2] !== undefined || co[5] !== undefined)) {
        const nx = co[1] !== undefined ? mm(+co[1]) : X;
        const ny = co[2] !== undefined ? mm(+co[2]) : Y;
        const i = co[3] !== undefined ? mm(+co[3]) : 0;
        const j = co[4] !== undefined ? mm(+co[4]) : 0;
        if (co[5] !== undefined) applyOp(+co[5], { nx, ny, i, j });
        X = nx; Y = ny;
        continue;
      }
      // 未知命令忽略
    }
  }
  function flushRegion() {
    if (region && region.contours.length) ops.push({ k: 'region', contours: region.contours.filter(c => c.length > 2), pol });
    region = null;
  }
  function applyOp(d, { nx, ny, i = 0, j = 0 }) {
    if (d === 2) {                                   // 移动
      if (region) { region.cur = [[nx, ny]]; region.contours.push(region.cur); }
      return;
    }
    if (d === 3) {                                   // 闪光
      if (region) { region.cur.push([nx, ny]); return; }
      ops.push({ k: 'flash', x: nx, y: ny, ap: cur, pol });
      return;
    }
    if (d === 1) {                                   // 绘制
      const pts = (interp === 2 || interp === 3) ? arcPoints(X, Y, nx, ny, i, j, interp) : [[X, Y], [nx, ny]];
      if (region) {
        if (!region.cur) { region.cur = [[X, Y]]; region.contours.push(region.cur); }
        for (let k = 1; k < pts.length; k++) region.cur.push(pts[k]);
      } else {
        ops.push({ k: 'draw', pts, ap: cur, pol });
      }
    }
  }
  return { ops, aps, macros };
}

function arcPoints(x0, y0, x1, y1, i, j, dir) {
  const cx = x0 + i, cy = y0 + j;
  let a0 = Math.atan2(y0 - cy, x0 - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
  const r = Math.hypot(x0 - cx, y0 - cy);
  if (dir === 2) { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 60)));
  const out = [];
  for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  out[out.length - 1] = [x1, y1];
  return out;
}

export class Canvas {
  constructor(minX, maxX, minY, maxY, pxPerMm, ss = 2) {
    this.minX = minX; this.maxY = maxY; this.pxPerMm = pxPerMm * ss; this.ss = ss;
    this.w = Math.ceil((maxX - minX) * pxPerMm * ss);
    this.h = Math.ceil((maxY - minY) * pxPerMm * ss);
    this.cov = new Uint8Array(this.w * this.h);
  }
  px(x) { return (x - this.minX) * this.pxPerMm; }
  py(y) { return (this.maxY - y) * this.pxPerMm; }
  set(ix, iy, v) { if (ix >= 0 && iy >= 0 && ix < this.w && iy < this.h) this.cov[iy * this.w + ix] = v; }
  circle(cx, cy, r, v) {
    const R = r * this.pxPerMm, X = this.px(cx), Y = this.py(cy);
    for (let y = Math.floor(Y - R); y <= Math.ceil(Y + R); y++) {
      for (let x = Math.floor(X - R); x <= Math.ceil(X + R); x++) {
        if ((x - X) ** 2 + (y - Y) ** 2 <= R * R) this.set(x, y, v);
      }
    }
  }
  ring(cx, cy, rOut, rIn, v) {
    const RO = rOut * this.pxPerMm, RI = rIn * this.pxPerMm, X = this.px(cx), Y = this.py(cy);
    for (let y = Math.floor(Y - RO); y <= Math.ceil(Y + RO); y++) {
      for (let x = Math.floor(X - RO); x <= Math.ceil(X + RO); x++) {
        const d2 = (x - X) ** 2 + (y - Y) ** 2;
        if (d2 <= RO * RO && d2 >= RI * RI) this.set(x, y, v);
      }
    }
  }
  rect(cx, cy, w, h, v, rotDeg = 0) {
    const th = rotDeg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
      .map(([dx, dy]) => [cx + dx * c - dy * s, cy + dx * s + dy * c]);
    this.poly([corners], v);
  }
  obround(cx, cy, w, h, v) {
    if (w > h) { this.circle(cx - (w - h) / 2, cy, h / 2, v); this.circle(cx + (w - h) / 2, cy, h / 2, v); }
    else { this.circle(cx, cy - (h - w) / 2, w / 2, v); this.circle(cx, cy + (h - w) / 2, w / 2, v); }
    this.poly([[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]], v);
  }
  // 偶奇规则扫描线填充（支持多轮廓挖孔）
  poly(contours, v) {
    const P = contours.map(c => c.map(([x, y]) => [this.px(x), this.py(y)]));
    let ymin = Infinity, ymax = -Infinity;
    for (const c of P) for (const [, y] of c) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    ymin = Math.max(0, Math.floor(ymin)); ymax = Math.min(this.h - 1, Math.ceil(ymax));
    const edges = [];
    for (const c of P) {
      for (let i = 0; i < c.length; i++) {
        const [x1, y1] = c[i], [x2, y2] = c[(i + 1) % c.length];
        if (y1 !== y2) edges.push({ x1, y1, x2, y2, ylo: Math.min(y1, y2), yhi: Math.max(y1, y2) });
      }
    }
    const xs = [];
    for (let y = ymin; y <= ymax; y++) {
      const yc = y + 0.5; xs.length = 0;
      for (const e of edges) {
        if (yc >= e.ylo && yc < e.yhi) xs.push(e.x1 + (yc - e.y1) * (e.x2 - e.x1) / (e.y2 - e.y1));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(this.w - 1, Math.floor(xs[k + 1]));
        for (let x = x0; x <= x1; x++) this.set(x, y, v);
      }
    }
  }
  paint(ops, invert = 0) {
    for (const op of ops) {
      const v = (op.pol ? 1 : 0) ^ invert;
      if (op.k === 'region') this.poly(op.contours, v);
      else if (op.k === 'draw') {
        const w = op.ap && op.ap.type === 'C' ? op.ap.params[0] : 0.254;
        for (let i = 0; i + 1 < op.pts.length; i++) {
          const [x1, y1] = op.pts[i], [x2, y2] = op.pts[i + 1];
          const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
          if (L < 1e-9) continue;
          const ox = -dy / L * w / 2, oy = dx / L * w / 2;
          this.poly([[[x1 + ox, y1 + oy], [x2 + ox, y2 + oy], [x2 - ox, y2 - oy], [x1 - ox, y1 - oy]]], v);
          this.circle(x1, y1, w / 2, v); this.circle(x2, y2, w / 2, v);
        }
      } else if (op.k === 'flash') {
        const ap = op.ap;
        if (!ap) continue;
        if (ap.type === 'C') this.circle(op.x, op.y, ap.params[0] / 2, v);
        else if (ap.type === 'R') this.rect(op.x, op.y, ap.params[0], ap.params[1], v);
        else if (ap.type === 'O') this.obround(op.x, op.y, ap.params[0], ap.params[1], v);
        else if (ap.type === 'MACRO') {
          for (const pr of ap.macroBody) {
            let pv = ((pr.exp === 1) === !!op.pol) ? 1 : 0;
            pv ^= invert;
            if (pr.k === 'thermal') {
              this.ring(op.x, op.y, pr.outer / 2, pr.inner / 2, pv);
              for (let k = 0; k < 4; k++) {          // 4 条连接筋：把环切开缺口
                const a = (pr.rot + 90 * k) * Math.PI / 180;
                const rMid = (pr.inner + pr.outer) / 4;
                this.rect(op.x + Math.cos(a) * rMid, op.y + Math.sin(a) * rMid,
                  pr.outer - pr.inner + 0.05, pr.gap, pv ? 0 : 1, pr.rot + 90 * k);
              }
            } else if (pr.k === 'circle') this.circle(op.x + pr.x, op.y + pr.y, pr.d / 2, pv);
            else if (pr.k === 'clrect') this.rect(op.x + pr.x, op.y + pr.y, pr.w, pr.h, pv, pr.rot);
          }
        }
      }
    }
  }
  // 降采样成 RGBA，color=[r,g,b]
  toRGBA(color, opts = {}) {
    const ss = this.ss, w = Math.floor(this.w / ss), h = Math.floor(this.h / ss);
    const out = new Uint8Array(w * h * 4);
    const [r, g, b] = color;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) s += this.cov[(y * ss + dy) * this.w + (x * ss + dx)];
        const a = s / (ss * ss);
        if (a <= 0) continue;
        const o = (y * w + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = Math.round(a * (opts.alpha === undefined ? 255 : opts.alpha));
      }
    }
    return { w, h, data: out };
  }
}

// 合成多张 RGBA（下层在前）
export function blend(w, h, layers) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const L of layers) {
      if (!L) continue;
      const sa = L.data[i * 4 + 3] / 255;
      if (sa <= 0) continue;
      const sr = L.data[i * 4], sg = L.data[i * 4 + 1], sb = L.data[i * 4 + 2];
      r = sr * sa + r * (1 - sa); g = sg * sa + g * (1 - sa); b = sb * sa + b * (1 - sa);
      a = sa + a * (1 - sa);
    }
    out[i * 4] = Math.round(r); out[i * 4 + 1] = Math.round(g); out[i * 4 + 2] = Math.round(b); out[i * 4 + 3] = Math.round(a * 255);
  }
  return { w, h, data: out };
}

// ---- PNG 输出 ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
export function writePNG(path, img, bg) {
  const { w, h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, q = y * (w * 4 + 1) + 1 + x * 4;
      const a = data[o + 3] / 255;
      // 与背景合成成不透明图（README 里显示更稳）
      raw[q] = Math.round(data[o] * a + bg[0] * (1 - a));
      raw[q + 1] = Math.round(data[o + 1] * a + bg[1] * (1 - a));
      raw[q + 2] = Math.round(data[o + 2] * a + bg[2] * (1 - a));
      raw[q + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path, png);
  return png.length;
}
