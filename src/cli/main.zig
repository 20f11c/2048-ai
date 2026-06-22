pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();

    const args = Args.parse(init) catch return;

    // ========== Search-only 模式 (HTTP 服务器调用) ==========
    if (args.search_only) |board_str| {
        var buffer: [256]u8 = undefined;
        var stdout: std.Io.File.Writer = .init(.stdout(), init.io, &buffer);
        const writer = &stdout.interface;

        // 解析 board (支持 0x 前缀)
        const board_data = std.fmt.parseUnsigned(u64, board_str, 0) catch {
            try writer.print("Error: Invalid board format\n", .{});
            return;
        };

        const board = Board{ .data = board_data };

        // 初始化引擎
        var move_table: Board.MoveTable = undefined;
        move_table.init();
        var heuristic: Heuristic = undefined;
        heuristic.init();

        const bfs_buffer = try allocator.alloc(Board, args.budget);
        var bfs = Bfs.new(bfs_buffer, &move_table);

        var cache: Expectimax.Cache = undefined;
        @memset(&cache.boards, 0);

        const expect = Expectimax{
            .move_table = &move_table,
            .heuristic = heuristic,
            .cache = &cache,
        };

        const moves = move_table.getMoves(board);
        const valid = board.filterMoves(&moves);
        if (valid.len == 0) {
            try writer.print("-1\n", .{}); // 无解
            return;
        }

        const depth = bfs.expand(valid.moves[0..valid.len]).depth + 1;
        const search_fn = expect.reset();
        const dir = search_fn.call(board, depth) orelse {
            try writer.print("-1\n", .{}); // 无解
            return;
        };

        try writer.print("{d}\n", .{@intCast(dir)});
        try writer.flush();
        return;
    }

    // ========== 正常批量游戏模式 ==========
    if (args.iterations == 0) return;

    var buffer: [4096]u8 = undefined;
    var stdout: std.Io.File.Writer = .init(.stdout(), init.io, &buffer);
    const writer = &stdout.interface;

    try args.display(writer);

    var move_table: LazyInit(Board.MoveTable) = .uninit;
    var heuristic: LazyInit(Heuristic) = .uninit;

    const bg_threads = args.threads - 1;

    var result: Stats = .empty;

    var write_lock: std.Io.Mutex = .init;
    var next_game: std.atomic.Value(u32) = .init(0);
    const shared: Worker.Shared = .{
        .args = args,
        .move_table = move_table.get(),
        .heuristic = heuristic.get(),
        .write_lock = &write_lock,
        .next_game = &next_game,
        .io = init.io,
        .arena = allocator,
    };

    if (bg_threads > 0) {
        const stats = try allocator.alloc(Stats, bg_threads);
        @memset(stats, .empty);

        _ = {
            const workers = try allocator.alloc(Worker, bg_threads);

            for (workers, 1..) |*worker, id| {
                worker.* = try .new(@intCast(id), &shared);
            }

            const threads = try allocator.alloc(std.Thread, bg_threads);
            for (threads, workers, stats) |*thread, *worker, *stat| {
                thread.* = try std.Thread.spawn(.{}, Worker.run_games, .{
                    worker,
                    stat,
                });
            }

            var worker: Worker = try .new(0, &shared);
            try worker.run_games(&result);

            for (threads) |*thread| thread.join();
        };

        var longest_time = result.total_time;
        for (stats) |*stat| {
            result = result.combine(stat);
            longest_time = @max(longest_time, stat.total_time);
        }

        const wall_time = longest_time / 1e9;
        const wall_speed = @as(f64, @floatFromInt(result.total_moves)) / wall_time;

        try result.display(writer, true);
        try writer.print("Wall Speed: {d:.2} moves/s\n", .{wall_speed});
        try writer.flush();
    } else {
        var worker: Worker = try .new(0, &shared);
        try worker.run_games(&result);

        try result.display(writer, true);
        try writer.flush();
    }
}

const std = @import("std");
const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Bfs = engine.Bfs;
const Expectimax = engine.Expectimax;

const Args = @import("Args.zig");
const Worker = @import("Worker.zig");
const Stats = @import("Stats.zig");
const LazyInit = @import("lazy_init.zig").LazyInit;
