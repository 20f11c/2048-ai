// WASM 小程序版 v4 —— 直接复用 engine.Expectimax, 100% 与原生 CLI 算法一致
// 导出 5 个函数:
//   init()                                  -> void
//   search(board_data: u64)                 -> i32       返回方向: 0上 1右 2下 3左, -1无解
//   applyMove(board_data: u64, dir: u32)    -> u64       应用移动后的新棋盘
//   addRandomTile(board_data: u64, rng)     -> u64       随机空格填子
//   countEmpty(board_data: u64)             -> u32       返回空格数

const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Bfs = engine.Bfs;
const Expectimax = engine.Expectimax;

var move_table: Board.MoveTable = undefined;
var heuristic: Heuristic = undefined;

// BFS 预算: 1 << 19 = 524288 Board ≈ 4MB (与原 CLI 默认完全相同)
const BFS_BUFFER_LEN = 1 << 19;
var bfs_buffer: [BFS_BUFFER_LEN]Board align(4096) = undefined;

// Expectimax 转置表 (2^18 = 262144 条目 ≈ 3.5MB)
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
    const valid = board.filterMoves(&moves);
    if (valid.len == 0) return -1;

    var bfs = Bfs.new(bfs_buffer[0..], &move_table);
    const depth = bfs.expand(valid.moves[0..valid.len]).depth + 1;

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

export fn addRandomTile(board_data: u64, rng_val: u32) u64 {
    const board = Board{ .data = board_data };
    return board.addTileInternal(rng_val).data;
}

export fn countEmpty(board_data: u64) u32 {
    const board = Board{ .data = board_data };
    return @popCount(board.emptyPos());
}
