// WASM 小程序版 v6 — 与原生 CLI 完全一致的算法，增大搜索预算
// 导出 5 个函数:
//   init()                                         -> void
//   search(board_data: u64)                        -> i32   (0上 1右 2下 3左, -1无解)
//   applyMove(board_data: u64, dir: u32)           -> u64
//   addRandomTile(board_data: u64, rng: u32)       -> u64
//   countEmpty(board_data: u64)                    -> u32

const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Bfs = engine.Bfs;
const Expectimax = engine.Expectimax;

var move_table: Board.MoveTable = undefined;
var heuristic: Heuristic = undefined;

// 关键改进: 增大 BFS 预算 (2M = 原 CLI 的 4 倍)
const BFS_BUFFER_LEN = 1 << 21;
var bfs_buffer: [BFS_BUFFER_LEN]Board align(4096) = undefined;

// 转置表: 2^18 = 262144 条目
var expectimax_cache: Expectimax(Heuristic, true).Cache = undefined;

// --- 导出函数 ---

export fn init() void {
    move_table.init();
    heuristic.init();
    @memset(&expectimax_cache.boards, 0);
    @memset(&expectimax_cache.depths, 0);
    @memset(&expectimax_cache.scores, 0);
}

export fn search(board_data: u64) i32 {
    const board = Board{ .data = board_data };

    const moves = move_table.getMoves(board);
    var valid_count: u8 = 0;
    var valid_boards: [4]Board = undefined;
    inline for (0..4) |dir| {
        if (moves[dir].data != board.data) {
            valid_boards[valid_count] = moves[dir];
            valid_count += 1;
        }
    }
    if (valid_count == 0) return -1;

    // 先做 BFS 动态分配深度
    var bfs = Bfs.new(bfs_buffer[0..], &move_table);
    const depth = bfs.expand(valid_boards[0..valid_count]).depth + 1;

    // Expectimax 搜索
    const expect = Expectimax(Heuristic, true){
        .move_table = &move_table,
        .heuristic = heuristic,
        .cache = &expectimax_cache,
    };
    const search_fn = expect.reset();
    const dir = search_fn.call(board, depth) orelse return -1;
    return @intCast(dir);
}

export fn applyMove(board_data: u64, dir: u32) u64 {
    const board = Board{ .data = board_data };
    const moves = move_table.getMoves(board);
    const d: u2 = @intCast(dir & 3);
    return moves[d].data;
}

export fn addRandomTile(board_data: u64, rng: u32) u64 {
    const board = Board{ .data = board_data };
    return board.addTileInternal(rng).data;
}

export fn countEmpty(board_data: u64) u32 {
    const board = Board{ .data = board_data };
    return @popCount(board.emptyPos());
}
