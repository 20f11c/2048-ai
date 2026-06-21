# 2048 AI — 规则变更技术方案

> 从「无限合成 2048」改为「2048 封顶、积分排名制」
> 目标：在无法移动之前，合成尽可能多的 2048，累计得分最大化

---

## 一、规则变更概述

### 1.1 新旧规则对比

| 维度 | 原版 2048 | 修改后版本 |
|------|----------|-----------|
| **合并上限** | 无限制（可达 32768+） | 2048 封顶（rank 11 = 2^11） |
| **2048 + 2048** | 合并为 4096 | **禁止合并**（2048 成为"死块"） |
| **2048 多块并存** | 不存在（立即合并为 4096） | **允许并存** |
| **2048 可移动** | — | 仍会随方向滑动，不影响移动 |
| **游戏结束条件** | 4 方向均无法移动 | 4 方向均无法移动（同原版） |
| **胜负判定** | 首次合成 2048 即胜利（可继续） | **积分排名制，无胜利点** |
| **核心目标** | 合成尽可能大的数字 | 合成尽可能多的 2048 |

### 1.2 棋盘表示

当前的 bitboard 表示 **无需改动**：

- 每个格子 4 位（`u4`），表示 rank 值
- rank `0` = 空格（值 0）
- rank `n`（n≥1）= 2^n
- rank `11` = 2048（封顶值）
- rank 范围 `0-11`，4 位完全容纳（最大 15）

整个棋盘仍然压缩到一个 `u64` 中。

### 1.3 游戏阶段模型

新版游戏引入了**棋盘老化**机制：

| 阶段 | 2048 数量 | 可用空间 | 策略核心 |
|------|----------|---------|---------|
| **早期**（0 个 2048） | 0 | 14~16 格 | 同原版：制造第一个 2048 |
| **中期**（1~3 个 2048） | 1~3 | 12~15 格 | 在 2048 周围继续合成，避免阻塞 |
| **后期**（4~6 个 2048） | 4~6 | 8~12 格 | 在缩小的操作区持续合成新 2048 |
| **终局**（7+ 个 2048） | 7+ | <8 格 | 棋盘固化，难以操作，游戏自然结束 |

**每一个 2048 都是「得分 + 空间损耗」的交易**。AI 的核心是「最大化交易效率」。

---

## 二、Board.zig 修改方案

### 2.1 修改 1：MoveTable — 阻止 2048 合并

**文件**：[src/engine/Board.zig](file:///workspace/src/engine/Board.zig)
**位置**：第 119 行（`MoveTable.init` 中的合并条件判断）

**原代码**：
```zig
if (!merged and furthest < 4 and line[i] == line[furthest]) {
    line[furthest] = line[furthest] +| 1;
    line[i] = 0;
    merged = true;
}
```

**修改后**：
```zig
if (!merged and furthest < 4 and line[i] == line[furthest] and line[i] < 11) {
    //                                    ^^^^^^^^^^^^^
    //                                    rank 11 = 2048
    //                                    两个 2048 相遇时不合并
    //                                    仍会滑动（由下方 else 分支处理），但值不变
    line[furthest] = line[furthest] +| 1;
    line[i] = 0;
    merged = true;
}
```

**效果说明**：
- 当两个相同 rank 的数字相邻，且 rank < 11（即 < 2048）时，正常合并
- 当 rank = 11（即 2048）时，跳过合并分支，执行滑动分支
- 两个 2048 仍然会"滑动靠近"（如果方向上有空间），但不会变成 4096
- 此修改只影响 `MoveTable.init()` 预计算的查表结果，运行时性能 **零开销**

**影响范围**：
- `forward_table[65536]` 和 `reverse_table[65536]` 的值会改变
- 所有行状态中包含 `[11, x, 11]` 或类似模式的查表结果不同
- WASM 和 CLI 两个版本共享此 MoveTable，**一次修改两处生效**

### 2.2 修改 2：新增 countRank — 统计特定 rank 的格子数量

**文件**：[src/engine/Board.zig](file:///workspace/src/engine/Board.zig)
**位置**：在 `maxTile()` 之后新增

```zig
/// 统计棋盘上 rank == target_rank 的格子数量
pub fn countRank(self: Board, target_rank: u4) u4 {
    var data = self.data;
    var count: u4 = 0;
    for (0..16) |_| {
        if (@as(u4, @truncate(data)) == target_rank) count += 1;
        data >>= 4;
    }
    return count;
}
```

**用途**：在评估函数中快速获取当前棋盘的 2048 数量。

### 2.3 修改 3：新增 layoutBonus — 2048 布局奖励

**文件**：[src/engine/Board.zig](file:///workspace/src/engine/Board.zig)
**位置**：在 `countRank()` 之后新增

```zig
/// 计算 2048 的布局奖励：边角 > 边缘 > 中心
/// 返回 f32 评分（正=好，负=坏）
pub fn layoutBonus2048(self: Board) f32 {
    const weights: [16]f32 = .{
        1500.0,   400.0,   400.0,  1500.0,
         400.0,  -800.0,  -800.0,   400.0,
         400.0,  -800.0,  -800.0,   400.0,
        1500.0,   400.0,   400.0,  1500.0,
    };
    // 权重说明：
    //   4 个角落 +1500：2048 停泊在角落不阻塞移动
    //   边缘非角 +400：还可以接受，不是最佳但不阻塞
    //   中心 2x2  -800：2048 在中心会严重阻塞所有方向

    var bonus: f32 = 0;
    var data = self.data;
    inline for (0..16) |pos| {
        if (@as(u4, @truncate(data >> (60 - pos * 4))) == 11) {
            bonus += weights[pos];
        }
    }
    return bonus;
}
```

**设计原则**：
- 角落（(0,0), (0,3), (3,0), (3,3)）：最佳停泊点，因为它只影响两条线
- 边缘但非角：中等停泊点，只影响一行/一列
- 中心 2x2 区域：**绝对禁区**，2048 在此会阻塞几乎所有合成路径

---

## 三、Heuristic.zig 完全重写方案

**文件**：[src/engine/Heuristic.zig](file:///workspace/src/engine/Heuristic.zig)

### 3.1 核心设计变更

| 特征 | 原版设计 | 新版设计 | 原因 |
|------|---------|---------|------|
| **空位奖励** | +270 | +400~600 | 空间比原版更珍贵，每个 2048 都消耗一格 |
| **可合并对奖励** | +700 | +400~600 | 鼓励持续制造合并机会 |
| **数字和 SUM** | -11 × sum^3.5（惩罚大数字） | +15~20 × sum^2.5（奖励大数字） | **反转**：原版怕大数字导致死局，新版大数字就是得分 |
| **单调性** | -47 × mono^4（惩罚不单调） | -5~15 × mono^3（轻度惩罚） | 降低权重，不再追求完美蛇形 |
| **2048 计数奖励** | 无 | +5000~20000/每个 | 核心目标奖励 |
| **2048 布局奖励** | 无 | +1500 角落 / -800 中心 | 引导停泊策略 |
| **死局惩罚** | +200000 | +200000（保留） | 严重惩罚无法移动的局面 |

### 3.2 完整重写代码

```zig
const Heuristic = @This();

score_table: [65536]f32;

const LOST_PENALTY = 200000.0;

// 新版权重（经过经验调优的初始建议值）
const MONO_POWER = 3.0;
const MONO_WEIGHT = 10.0;       // 降低：不再追求完美蛇形
const SUM_POWER = 2.5;
const SUM_WEIGHT = 18.0;        // 改为正值：大数字 = 奖励
const MERGES_WEIGHT = 500.0;    // 保持：鼓励制造合并机会
const EMPTY_WEIGHT = 500.0;     // 提高：空间更珍贵
const TILE_2048_WEIGHT = 8000.0; // 每个 2048 的基础奖励（查表内）
// 全局布局奖励在 evaluate() 中单独计算

pub fn init(self: *Heuristic) void {
    const pow_tables = comptime pow_tables: {
        var sum_pow_table: [16]f32 = undefined;
        var mono_pow_table: [16]f32 = undefined;

        for (1..16) |idx| {
            const fidx: f32 = @floatFromInt(idx);
            sum_pow_table[idx] = @exp2(@log2(fidx) * SUM_POWER);
            mono_pow_table[idx] = @exp2(@log2(fidx) * MONO_POWER);
        }

        sum_pow_table[0] = 0;
        mono_pow_table[0] = 0;

        break :pow_tables .{
            .sum = sum_pow_table,
            .mono = mono_pow_table,
        };
    };

    for (&self.score_table, 0..) |*entry, row| {
        const line = [_]u4 {
            @truncate(row >> 0),
            @truncate(row >> 4),
            @truncate(row >> 8),
            @truncate(row >> 12),
        };

        var sum: f32 = 0;
        var empty: u32 = 0;
        var merges: u32 = 0;
        var count_2048: u32 = 0;

        var prev: u4 = 0;
        var counter: u32 = 0;

        inline for (line) |rank| {
            sum += pow_tables.sum[rank];

            if (rank == 11) count_2048 += 1;

            if (rank == 0) {
                empty += 1;
            } else {
                // 注意：2048(rank 11) 不计入"可合并对"
                // 因为它实际上不能再合并了
                if (prev == rank and rank < 11) {
                    counter += 1;
                } else if (counter > 0) {
                    merges += 1 + counter;
                    counter = 0;
                }

                prev = rank;
            }
        }

        if (counter > 0) merges += 1 + counter;

        // 计算单调性
        var mono_left: f32 = 0;
        var mono_right: f32 = 0;
        inline for (1..4) |i| {
            const l = pow_tables.mono[line[i - 1]];
            const r = pow_tables.mono[line[i]];

            if (line[i - 1] > line[i]) {
                mono_left += l - r;
            } else {
                mono_right += r - l;
            }
        }

        const _2048_bonus = @as(f32, @floatFromInt(count_2048)) * TILE_2048_WEIGHT;

        entry.* = LOST_PENALTY
            + EMPTY_WEIGHT * @as(f32, @floatFromInt(empty))
            + MERGES_WEIGHT * @as(f32, @floatFromInt(merges))
            + SUM_WEIGHT * sum                   // 改为正值：奖励大数字
            + _2048_bonus                        // 2048 越多越好
            - MONO_WEIGHT * @min(mono_left, mono_right); // 降低单调性权重
    }
}

pub fn evaluate(self: *const Heuristic, board: Board) f32 {
    const data = board.data;
    const transposed = board.transpose().data;
    var score: f32 = 0;

    // 行/列查表（保留原版架构，速度不变）
    inline for (0..4) |idx| {
        const shift = comptime idx * 16;
        const row: u16 = @truncate(data >> shift);
        const col: u16 = @truncate(transposed >> shift);

        score += self.score_table[row] + self.score_table[col];
    }

    // 全局布局奖励（2048 在边角 vs 中心）
    // 这部分无法按行独立查表，需扫描整个棋盘
    score += board.layoutBonus2048();

    return score;
}

const Board = @import("Board.zig");
```

### 3.3 为什么这样设计

**保留查表架构**：
- `score_table[65536]` 是性能的关键——O(1) 查表 vs 每次扫描 16 格
- 所有能按行/列独立计算的特征仍然在表内预计算
- 只有「全局布局奖励」（2048 在哪一格）无法按行分解，才在 evaluate() 中单独扫描

**权重反转是核心**：
- 原版 `SUM_WEIGHT` 是**惩罚**大数字——因为大数字导致的"高位锁定"在原版中是风险（可能破坏单调性导致死局）
- 新版 `SUM_WEIGHT` 是**奖励**大数字——因为大数字 = 更多得分，2048 封顶意味着没有"更高位的风险"
- 这是整个评估函数的**最关键变化**

**单调性权重降低**：
- 原版中，一条完美递增的蛇形是合成 16384+ 的必要条件
- 新版中，操作区域只占棋盘的 60~80%，需要在 2048 之间"绕路"，过度单调反而可能阻塞

---

## 四、search.zig / Worker.zig / wasm/main.zig — 无需修改

**search.zig**：无需修改。Expectimax 的搜索逻辑保持不变——它只是调用新的 `heuristic.evaluate()` 获取评分。

**Worker.zig**：游戏主循环保持不变。结束条件仍然是「没有有效移动」（`search.call()` 返回 `null`）。

**wasm/main.zig**：无需修改。`export fn search()` 的接口不变，只是内部调用的评估结果不同。

---

## 五、参数调优指南

### 5.1 建议的参数空间

| 参数 | 建议范围 | 基础值 | 增大的效果 | 减小的效果 |
|------|---------|--------|-----------|-----------|
| `EMPTY_WEIGHT` | 300~700 | 500 | 更保守，留更多空间，避免过早死局 | 更激进，优先合成而非留空 |
| `MERGES_WEIGHT` | 300~700 | 500 | 积极制造合并机会，可能忽略布局 | 更重视长期布局而非短期合并 |
| `SUM_WEIGHT` | 10~30 | 18 | 追求快速合成大数字，可能忽略空间管理 | 稳扎稳打，防止操作空间耗尽 |
| `SUM_POWER` | 2.0~3.0 | 2.5 | 大数字相对权重更高，极端追求合成 | 小数字权重相对增加，更平衡 |
| `MONO_WEIGHT` | 5~20 | 10 | 鼓励蛇形/单调布局，可能过度保守 | 更灵活，允许非单调布局 |
| `TILE_2048_WEIGHT` | 5000~20000 | 8000 | 每个 2048 的"获得感"更强 | 降低 2048 的优先级，追求长期效率 |
| **layoutBonus 角落权重** | 1000~2000 | 1500 | 更强的停泊到角落倾向 | 2048 位置更自由 |
| **layoutBonus 中心权重** | -400 ~ -1200 | -800 | 更强的禁止中心倾向 | 中心允许 2048 |

### 5.2 调优策略

1. **先跑基线**：用基础值跑 100~1000 局游戏，记录平均 2048 数量、平均分、平均步数
2. **单变量扫描**：每次只改一个参数，跑 100 局，观察效果
3. **重点关注**：
   - 平均 2048 数量（核心指标）
   - 失败时的典型局面（是空间耗尽？还是合成路径阻塞？）
   - 每局平均步数（反映"策略效率"）
4. **验证单调性参数是否应该降低**：如果 AI 经常把 2048 放在中心，提高中心惩罚；如果 AI 有空间但不知如何合成，降低单调性权重

### 5.3 典型问题诊断

| 症状 | 可能原因 | 调整方向 |
|------|---------|---------|
| 2048 频繁出现在中心，阻塞合成 | layoutBonus 中心惩罚不足 | 提高中心负权重（如 -1000 → -1200） |
| 合成 2 个 2048 后很快死局 | 过于激进合成，忽略空位管理 | 提高 EMPTY_WEIGHT，降低 SUM_WEIGHT |
| 总是在同一角落堆积，操作空间畸形 | 角落奖励过强，多样性不足 | 降低 TILE_2048_WEIGHT，提高 MONO_WEIGHT |
| 合成路径被 2048 阻挡，小数字无法合并 | 2048 位置策略差 | 增强 layoutBonus 的差异（角落更高，中心更低） |
| 得分偏低但 2048 数量不差 | SUM_WEIGHT 太低，不追求每次合并的数字大小 | 提高 SUM_WEIGHT |

---

## 六、预期性能与效果

### 6.1 搜索深度

由于 rank 范围缩小到 0~11（原版 0~15+），BFS 中的去重效率更高，**搜索深度实际上会增加**：

| 阶段 | 原版本深度 | 新版本深度 | 原因 |
|------|-----------|-----------|------|
| 开局（14 空格） | 1~2 | 2~3 | 同 rank 的重复局面更多 |
| 中期（6~8 空格） | 3~5 | 4~6 | rank 空间缩小，搜索更高效 |
| 后期（2~3 空格） | 6~8 | 7~10 | 相同 |

**搜索速度**：由于 evaluate() 增加了一次 `layoutBonus2048()` 的全盘扫描（16 格 × f32 比较），开销增加约 5~10%。整体速度应在 **300~1000 步/秒** 范围内（取决于预算和局面）。

### 6.2 AI 达成目标能力

理论上，熟练玩家手动操作可以达成 3~6 个 2048。Expectimax AI 应该能做到：

- **稳定达成 3 个 2048**（基准目标）
- **50% 以上局数达成 4~5 个 2048**（良好表现）
- **偶尔达成 6+ 个 2048**（优化后的顶级表现）

这取决于布局权重和空间管理参数的精细调优。

### 6.3 评分对比

原版 AI（预算 2^17）平均得分约 **~20 万~30 万**（追求大数字）。
你的版本中，单个 2048 合成得分 = 2048 × log2(2048) = 2048 × 11 ≈ 22,528 分（加上所有中间合并的分数，每个 2048 实际贡献约 **30,000~45,000 分**）。

预计：
- 3 个 2048 → 约 **100,000~150,000 分**
- 5 个 2048 → 约 **180,000~250,000 分**
- 7 个 2048 → 约 **260,000~350,000 分**

---

## 七、修改清单总结

| # | 文件 | 改动内容 | 位置 | 估计代码量 |
|---|------|---------|------|-----------|
| 1 | [src/engine/Board.zig](file:///workspace/src/engine/Board.zig) | MoveTable.init() 合并条件加 `line[i] < 11` | 第 119 行附近 | 1 行 |
| 2 | [src/engine/Board.zig](file:///workspace/src/engine/Board.zig) | 新增 `countRank()` 方法 | 在 `maxTile()` 之后 | 10 行 |
| 3 | [src/engine/Board.zig](file:///workspace/src/engine/Board.zig) | 新增 `layoutBonus2048()` 方法 | 在 `countRank()` 之后 | 25 行 |
| 4 | [src/engine/Heuristic.zig](file:///workspace/src/engine/Heuristic.zig) | 完全重写：权重反转 + 新增 2048 相关奖励 + 调用 `layoutBonus2048()` | 全文 | ~120 行 |
| 5 | search.zig | **无需修改** | — | — |
| 6 | Worker.zig | **无需修改** | — | — |
| 7 | wasm/main.zig | **无需修改** | — | — |

**总改动**：约 150 行新增/修改代码，主要集中在 Heuristic.zig 和 Board.zig。
**零接口变更**：`search(board_data: u64) -> i32` 的 WASM 接口完全不变。

---

## 八、进阶优化方向（可选）

### 8.1 操作区识别（高级）

如果基础方案表现不够理想，可以引入**动态操作区识别**：

```
策略思路：
1. 识别当前棋盘中"活跃操作区"——小数字分布的区域
2. 识别"停泊区"——2048 所在的角落
3. 评估函数对操作区内的特征（空位、合并机会、单调性）给更高权重
4. 停泊区的 2048 位置稳定性（不移动）给额外奖励
```

这需要在 `evaluate()` 中增加更复杂的局面分析，搜索速度会下降 20~40%，但策略质量可能显著提升。

### 8.2 多目标奖励分阶段

不同阶段使用不同权重：

```zig
// 在 evaluate() 中根据 2048 数量动态调整权重
const count_2048 = board.countRank(11);

if (count_2048 == 0) {
    // 早期：像原版一样追求合成第一个 2048
    // 使用更高的单调性权重和 SUM 奖励
} else if (count_2048 <= 2) {
    // 中期：平衡合成与空间管理
} else {
    // 后期：空间管理压倒一切，空位权重最大化
}
```

### 8.3 蒙特卡洛模拟验证

使用 CLI 模式批量跑 1000 局，统计不同参数下的得分分布：

```bash
zig build --release=fast
# 跑基线（默认参数）
./zig-out/bin/2048 -i 1000 -s baseline_seed
# 修改参数后重新编译对比
./zig-out/bin/2048 -i 1000 -s baseline_seed  # 同 seed 对比
```
