# gerber2png — 从 Gerber 数据渲染 PCB 图层图

作品集里所有 PCB 配图（顶层/底层/内电层/装配视图）都是用这个脚本**从 Gerber 明文数据**渲染出来的，
不是 EDA 软件截图 —— **图上的图形就是板厂拿到的图形**，所以可以直接拿去核对交付文件。
所有配图都能由本脚本从仓库内的 Gerber 数据**逐字节复现**。

## 用法

```bash
# 顶层铜箔（红）
node gerber2png.mjs --out 顶层.png \
     --copper "../Butterworth低通滤波器/四层版/Gerber/butterworth_4layer.GTL" \
     --gko    "../Butterworth低通滤波器/四层版/Gerber/butterworth_4layer.GKO"

# 内电层（负片：整板铺满后把"挖空"图形擦掉）
node gerber2png.mjs --out L3电源平面.png --copper ".../butterworth_4layer.GP2" \
     --gko ".../butterworth_4layer.GKO" --color "#e8a63e" --negative

# 装配视图 = 铜箔 + 丝印 + 板框 + 钻孔
node gerber2png.mjs --out 顶层装配视图.png --copper ".../Gerber_TopLayer.GTL" \
     --silk ".../Gerber_TopSilkscreenLayer.GTO" --gko ".../Gerber_BoardOutlineLayer.GKO" \
     --drill ".../Drill_PTH_Through.DRL" --color "#e84c34" --assembly
```

| 选项 | 说明 |
|---|---|
| `--copper` / `--out` | 要渲染的铜层文件 / 输出 PNG（必填） |
| `--gko` | 板框层：同时决定画面范围与板框描边（省略则按铜层范围自适应） |
| `--silk` | 丝印层（装配视图时叠加） |
| `--drill` | 钻孔文件（Excellon）：画成黑孔 |
| `--color` | 铜箔颜色，如 `#e84c34` |
| `--negative` | 该层是负片（内电层）：先整板铺满，再把 dark 图形当"挖空"擦除 |
| `--pullback` | 负片距板边的内缩量 mm（默认 0.5，对应 AD 的平面 pullback） |
| `--assembly` | 装配视图模式（铜 + 丝印 + 板框 + 钻孔） |
| `--mm` / `--ss` | 分辨率 px/mm（默认 24）/ 超采样倍数（默认 2，抗锯齿） |

## 支持的 Gerber 子集（够用且已验证）

**同时兼容 Altium Designer 与嘉立创EDA 两种导出风格**（两家写法差异都已处理并在本仓库实测通过）：

| 差异点 | Altium | 嘉立创EDA |
|---|---|---|
| 坐标格式 | `%FSLAX44Y44*%`（4 位整数 4 位小数） | `%FSLAX45Y45*%`（4 位整数 **5 位小数**） |
| G 码位置 | 单独一行（`G01*`） | **与坐标同行**（`G01X..Y..D01*`、`G54D10*`） |
| 圆弧 | 少用 | 大量 `G02/G03` + `I/J` |
| 钻孔 | 定点整数（`X-102870`，`;FILE_FORMAT=4:4`） | **带小数点**（`X0.0Y7.02194`） |

其他已实现：`G36/G37` 区域填充（偶奇规则，可含多轮廓挖孔）、`D01/D02/D03`、`D10+` 选光圈、
`%LPD*%/%LPC*%` 极性、内电层整体反相、光圈 `C/R/O`、**光圈宏 `%AM...%`（含 primitive 7 = 热焊盘：环 + 4 条连接筋）**、
自带 PNG 编码器（zlib + CRC32），无第三方依赖。

## 环境

Node.js ≥ 18，无 npm 依赖：

```bash
node --version   # 本仓库出图用的是 v24.16.0
```
