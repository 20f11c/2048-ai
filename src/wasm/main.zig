const Expectimax = engine.Expectimax(*const Heuristic, true);

var ctx: struct {
    move_table: Board.MoveTable,
    heuristic: Heuristic,
    cache: Expectimax.Cache,
} = undefined;

const search_fn = blk: {
    const expectimax: Expectimax = .{
        .move_table = &ctx.move_table,
        .heuristic = &ctx.heuristic,
        .cache = &ctx.cache,
    };
    break :blk expectimax.reset();
};

export fn init() void {
    ctx.move_table.init();
    ctx.heuristic.init();
    _ = search_fn.inner.reset();
}

export fn search(board_data: u64) i32 {
    const S = struct {
        var bfs_buffer: [327680]Board = undefined;
    };
    const board: Board = .{ .data = board_data };
    const moves = ctx.move_table.getMoves(board);
    const valid = board.filterMoves(&moves);
    const buffer = S.bfs_buffer[0..S.bfs_buffer.len];
    var bfs: Bfs = .new(buffer, &ctx.move_table);
    const depth = bfs.expand(valid.moves[0..valid.len]).depth + 1;
    const dir = search_fn.call(board, depth);
    return dir orelse -1;
}

export fn applyMove(board_data: u64, dir: u32) u64 {
    const board: Board = .{ .data = board_data };
    const moves = ctx.move_table.getMoves(board);
    return moves[@intCast(dir)].data;
}

export fn countEmpty(board_data: u64) u32 {
    const board: Board = .{ .data = board_data };
    const mask = board.emptyPos();
    return @popCount(mask);
}

export fn addRandomTile(board_data: u64, rng_val: u32) u64 {
    const board: Board = .{ .data = board_data };
    const mask = board.emptyPos();
    const empty_count = @popCount(mask);
    if (empty_count == 0) return board_data;

    const idx = rng_val % empty_count;
    const rank: u4 = if ((rng_val >> 16) % 10 == 0) 2 else 1;

    var t = mask;
    for (0..idx) |_| {
        t &= t - 1;
    }
    const pos_bit = t & -%t;

    return board.data | (@as(u64, rank) * pos_bit);
}

export fn countRank(board_data: u64, rank: u32) u32 {
    var data = board_data;
    var count: u32 = 0;
    const r: u4 = @intCast(rank);
    for (0..16) |_| {
        if (@as(u4, @truncate(data)) == r) count += 1;
        data >>= 4;
    }
    return count;
}

export fn maxTile(board_data: u64) u32 {
    const board: Board = .{ .data = board_data };
    return @intCast(board.maxTile());
}

const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Bfs = engine.Bfs;
