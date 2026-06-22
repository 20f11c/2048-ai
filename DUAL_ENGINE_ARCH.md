# 2048 AI 双引擎架构设计

## 目标
小程序通过统一接口调用 AI，底层自动选择 WASM 或云托管：
- **阶段 1** (未达成 2048): WASM 计算，目标是稳定达成 1 个 2048
- **阶段 2** (已达成 2048): 云托管 CLI 高性能计算，目标 3+ 2048

## 统一接口设计

### 核心函数 (WASM & HTTP 通用)
```javascript
// 统一 AI 接口
const AI = {
  init(wasmPath, apiUrl, onReady) {},           // 初始化
  search(cells) {},                              // 搜索最佳方向
  applyMove(cells, dir) {},                      // 应用移动
  addRandomTile(cells, rng) {},                  // 添加随机块
  countEmpty(cells) {},                         // 空格数
  has2048(cells) {},                            // 检测是否有 2048
  isReady() {},                                  // 是否就绪
}
```

### 静默切换逻辑
```javascript
function search(cells) {
  if (has2048(cells) && cloudReady) {
    return cloudSearch(cells);  // 云托管
  }
  return wasmSearch(cells);   // WASM
}
```

## 方案 A: 小程序 WASM

### 配置 (内存 = 9.6MB，符合小程序 10MB 限制)
| 组件 | 大小 | 说明 |
|------|------|------|
| BFS buffer | 6.4 MB | 838848 entries |
| Cache | 3.25 MB | 262144 entries |
| Stack | 2 MB | 防止递归栈溢出 |
| MoveTable | 0.13 MB | 预计算移动表 |
| Heuristic | 0.25 MB | 启发式评估表 |
| **总计** | **~9.6 MB** | 卡着 10MB 限制 |

### 目标
- 稳定达成 **≥1 个 2048**
- 达成率: **100%** (实测 20 局)
- 每步耗时: ~20-30ms

### 编译
```bash
zig build --release=fast
# 输出: zig-out/main.wasm (~7KB)
```

## 方案 B: 云托管 HTTP API

### 部署环境
- 高性能服务器 (CPU 4核+, 内存 8GB+)
- 无内存限制，可运行完整版 CLI

### 配置
| 组件 | 大小 | 说明 |
|------|------|------|
| BFS buffer | 4 MB | 1<<19 = 524288 entries (同 CLI) |
| Cache | 3.2 MB | 1<<18 = 262144 entries |
| Stack | 8 MB | 防止栈溢出 |

### HTTP API 设计

#### POST /search
```json
// Request
{
  "board": "0x123456789ABCDEF0",  // 棋盘 u64
  "timeout_ms": 1000              // 超时限制
}

// Response
{
  "direction": 0,                // 0=上, 1=右, 2=下, 3=左
  "elapsed_ms": 45,
  "depth": 8,
  "nodes": 125000
}

// Error
{
  "error": "timeout",
  "direction": 2                  // 超时返回默认方向
}
```

#### POST /init
```json
// Request
{}

// Response
{
  "status": "ok",
  "version": "1.0.0"
}
```

#### GET /health
```json
{
  "status": "healthy",
  "uptime": 3600
}
```

### 技术选型
- Zig HTTP 库: `h11` 或 `tiny_http`
- 或使用 Python/FastAPI 包装 CLI

## 文件结构
```
/workspace/
├── src/
│   ├── wasm/
│   │   └── main.zig          # WASM 版本 (4MB 内存)
│   ├── cli/
│   │   └── main.zig          # CLI 版本
│   └── engine/               # 共享引擎
│       ├── Board.zig
│       ├── Heuristic.zig
│       ├── Bfs.zig
│       └── search.zig
├── server/
│   └── main.zig              # HTTP 云服务
├── js/
│   └── ai2048.js             # 统一接口 (自动切换)
└── wasm/
    └── main.wasm             # 编译产物 (~7KB)
```

## 切换流程
```
用户操作 → 检测棋盘状态 → 选择引擎
                              │
              ┌───────────────┴───────────────┐
              ↓                               ↓
        未含 2048                        已有 2048
              ↓                               ↓
        WASM 计算                        云托管计算
        (~30ms/步)                      (~13ms/步)
              ↓                               ↓
         达成 2048?                      继续游戏
              │
        ┌─────┴─────┐
        ↓           ↓
       是           否
        ↓           ↓
      切换       继续 WASM
      云托管
```
