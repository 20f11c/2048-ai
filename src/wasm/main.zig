// WASM: 2048 AI 引擎 —— 微信小程序 / Node.js / 浏览器
// 编译: zig build --release=fast  →  zig-out/main.wasm
// 内存优化: 总内存 < 10MB，适配小程序限制
// 导出: init() + search() + applyMove() + addRandomTile() + countEmpty()

const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Bfs = engine.Bfs;
const Expectimax = engine.Expectimax;

var move_table: Board.MoveTable = undefined;
var heuristic: Heuristic = undefined;

// 小程序内存优化版: 总内存 < 10MB
// BFS buffer: 1<<17 = 131072 × 8B = 1MB
// Cache: 1<<16 = 65536 × 13B = 0.8MB
// Stack: 2MB
// 其他: ~0.5MB
// 总计: ~4.3MB (安全范围内)

const BFS_BUFFER_LEN = 1 << 17; // 131072, 小程序内存优化
var bfs_buffer: [BFS_BUFFER_LEN]Board align(4096) = undefined;

// 使用更小的 Cache (16 bits = 65536 entries)
const SmallExpectimax = Expectimax(Heuristic, true, 16);
var expectimax_cache: SmallExpectimax.Cache = undefined;

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

    var bfs = Bfs.new(bfs_buffer[0..], &move_table);
    const depth = bfs.expand(valid_boards[0..valid_count]).depth + 1;

    // Expectimax (小 Cache 版本)
    const expect = SmallExpectimax{
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