const std = @import("std");
const Board = @import("engine/Board.zig");
const Bfs = @import("engine/Bfs.zig");
const Heuristic = @import("engine/Heuristic.zig");
const Expectimax = @import("engine/search.zig").Expectimax;

const ExpectimaxCache = Expectimax(Heuristic, true, 18);

const BFS_BUF_SIZE = 838848;

// 全局状态（线程安全初始化）
var move_table: Board.MoveTable = undefined;
var heuristic: Heuristic = undefined;
var cache: ExpectimaxCache.Cache = undefined;
var bfs_buf: [BFS_BUF_SIZE]Board = undefined;
var initialized: std.atomic.Value(bool) = .{ .raw = false };

fn ensureInit() void {
    if (initialized.load(.acquire)) return;
    move_table.init();
    heuristic.init();
    @memset(&cache.boards, 0);
    @memset(&cache.depths, 0);
    @memset(&cache.scores, 0);
    initialized.store(true, .release);
}

// 返回方向 0-3，-1 表示无有效移动
export fn search(board_data: u64) c_int {
    ensureInit();

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

    var bfs = Bfs.new(&bfs_buf, &move_table);
    const depth = bfs.expand(valid_boards[0..valid_count]).depth + 1;

    const expect = ExpectimaxCache{
        .move_table = &move_table,
        .heuristic = heuristic,
        .cache = &cache,
    };
    const search_fn = expect.reset();
    const dir = search_fn.call(board, depth) orelse return -1;
    return @intCast(dir);
}
