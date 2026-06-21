// WASM 小程序版 v2 —— 用内置 Expectimax(带转置表)
// 导出: init() + step(u64 board) -> u64

const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Bfs = engine.Bfs;
const Expectimax = engine.Expectimax;

var move_table: Board.MoveTable = undefined;
var heuristic: Heuristic = undefined;

// BFS 预算: 327680 Board = ~2.5MB, 匹配原 WASM 版本预算
// BFS buffer 越大 → BFS 展开越深 → Expectimax 深度越大 → 每步越慢
const BFS_BUFFER_LEN = 327680;
var bfs_buffer: [BFS_BUFFER_LEN]Board align(4096) = undefined;

// 转置表缓存(2^14 = 16384 条目, 每条目 16B = ~256KB)
const Cache = struct {
    const CACHE_BITS = 14;
    const CACHE_SIZE = 1 << CACHE_BITS;
    depths: [CACHE_SIZE]u8 align(16),
    boards: [CACHE_SIZE]u64 align(16),
    scores: [CACHE_SIZE]f32 align(16),

    fn insert(self: *Cache, board: Board, depth: u8, score: f32) void {
        const h = board.hash(CACHE_BITS);
        self.boards[h] = board.data;
        self.depths[h] = depth;
        self.scores[h] = score;
    }

    fn query(self: *Cache, board: Board, depth: u8) ?f32 {
        const h = board.hash(CACHE_BITS);
        if (self.boards[h] != board.data or self.depths[h] < depth) return null;
        return self.scores[h];
    }
};
var cache: Cache = undefined;

// 内联的 Expectimax 搜索（直接嵌入,减少函数调用开销）
fn bestMove(board: Board, depth: u8) ?u2 {
    var best: ?u2 = null;
    var best_score: f32 = 0;
    const moves = move_table.getMoves(board);
    inline for (0..4) |dir| {
        if (moves[dir].data != board.data) {
            const score = expectNode(moves[dir], depth);
            if (score > best_score) {
                best_score = score;
                best = @intCast(dir);
            }
        }
    }
    return best;
}

fn expectNode(board: Board, depth: u8) f32 {
    if (depth == 0) return heuristic.evaluate(board);

    // 转置表查询
    const ch = cache.boards[board.hash(14)];
    if (ch == board.data) {
        const cd = cache.depths[board.hash(14)];
        if (cd >= depth) return cache.scores[board.hash(14)];
    }

    const mask = board.emptyPos();
    const count: u32 = @popCount(mask);
    if (count == 0) return heuristic.evaluate(board);

    var score: f32 = 0;
    const fc: f32 = @floatFromInt(count);
    const w2: f32 = 0.9 / fc;
    const w4: f32 = 0.1 / fc;
    var t = mask;

    while (t != 0) {
        const tile = t & -%t;
        t ^= tile;
        score += w2 * maxNode(Board{ .data = board.data | tile }, depth);
        score += w4 * maxNode(Board{ .data = board.data | (tile << 1) }, depth);
    }

    cache.insert(board, depth, score);
    return score;
}

fn maxNode(board: Board, depth: u8) f32 {
    var max_score: f32 = 0;
    const moves = move_table.getMoves(board);
    inline for (0..4) |dir| {
        if (moves[dir].data != board.data) {
            max_score = @max(max_score, expectNode(moves[dir], depth - 1));
        }
    }
    return max_score;
}

// 简易 RNG（LCG）
var rng_state: u32 = 0xC0FFEE;

inline fn nextRand() u32 {
    rng_state = rng_state *% 1664525 +% 1013904223;
    return rng_state;
}

// --- 导出函数 ---

export fn init() void {
    move_table.init();
    heuristic.init();
    @memset(&cache.depths, 0);
    @memset(&cache.boards, 0);
    @memset(&cache.scores, 0);
}

export fn step(board_data: u64) u64 {
    var board = Board{ .data = board_data };

    // 空棋盘 = 新游戏, 填两个初始块
    if (board.data == 0) {
        board = Board{ .data = 0 };
        board = board.addTileInternal(nextRand());
        board = board.addTileInternal(nextRand());
        return board.data;
    }

    // BFS 动态分配搜索深度
    const moves = move_table.getMoves(board);
    const valid = board.filterMoves(&moves);
    if (valid.len == 0) return board.data;

    var bfs = Bfs.new(bfs_buffer[0..], &move_table);
    const depth = bfs.expand(valid.moves[0..valid.len]).depth + 1;

    // Expectimax 搜索
    const dir = bestMove(board, depth) orelse return board.data;

    const moved = moves[dir];
    if (moved.data == board.data) return board.data;

    // 随机填子
    return moved.addTileInternal(nextRand()).data;
}
