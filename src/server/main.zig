const std = @import("std");
const os = std.os.linux;
const engine = @import("engine");
const Board = engine.Board;
const Heuristic = engine.Heuristic;
const Expectimax = engine.Expectimax;

const ExpectimaxCache = Expectimax(Heuristic, true, 18);

const ThreadState = struct {
    move_table: Board.MoveTable,
    heuristic: Heuristic,
    cache: ExpectimaxCache.Cache,
    bfs_buf: []Board,
};

fn writeAll(fd: i32, data: []const u8) void {
    var offset: usize = 0;
    while (offset < data.len) {
        const n = os.write(fd, data.ptr + offset, data.len - offset);
        if (n <= 0) return;
        offset += @intCast(n);
    }
}

fn readAll(fd: i32, buf: []u8) usize {
    var total: usize = 0;
    while (total < buf.len) {
        const n = os.read(fd, buf.ptr + total, buf.len - total);
        if (n <= 0) break;
        total += @intCast(n);
        // 简单处理：读到空行或末尾就停
        if (total >= 4) {
            const tail = buf[total -% 4 .. total];
            if (tail[0] == '\r' and tail[1] == '\n' and tail[2] == '\r' and tail[3] == '\n') break;
        }
    }
    return total;
}

fn findJsonStart(buf: []const u8) usize {
    for (buf, 0..) |c, i| {
        if (c == '{') return i;
    }
    return buf.len;
}

fn parseBoardField(json: []const u8) ?u64 {
    const key = "\"board\"";
    const idx = std.mem.indexOf(u8, json, key) orelse return null;
    var i = idx + key.len;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t' or json[i] == '\r' or json[i] == '\n' or json[i] == ':' or json[i] == '"')) i += 1;
    const start = i;
    while (i < json.len and json[i] >= '0' and json[i] <= '9') i += 1;
    if (i == start) return null;
    return std.fmt.parseUnsigned(u64, json[start..i], 10) catch null;
}

fn parseCellsField(json: []const u8) ?[16]u32 {
    const key = "\"cells\"";
    const idx = std.mem.indexOf(u8, json, key) orelse return null;
    var i = idx + key.len;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t' or json[i] == '\r' or json[i] == '\n' or json[i] == ':' or json[i] == '[')) i += 1;
    var cells: [16]u32 = .{0} ** 16;
    var count: usize = 0;
    while (count < 16 and i < json.len) {
        while (i < json.len and (json[i] == ' ' or json[i] == '\t' or json[i] == '\n' or json[i] == '\r' or json[i] == ',')) i += 1;
        if (i < json.len and json[i] == ']') break;
        const num_start = i;
        while (i < json.len and json[i] >= '0' and json[i] <= '9') i += 1;
        if (i == num_start) break;
        cells[count] = std.fmt.parseUnsigned(u32, json[num_start..i], 10) catch 0;
        count += 1;
    }
    return cells;
}

fn cellsToBoard(cells: *const [16]u32) u64 {
    var data: u64 = 0;
    for (cells) |val| {
        const rank: u64 = if (val == 0) 0 else @truncate(@as(u32, @intCast(@ctz(val))));
        data = (data << 4) | rank;
    }
    return data;
}

fn doSearch(state: *ThreadState, board_data: u64) i32 {
    const board = Board{ .data = board_data };
    const moves = state.move_table.getMoves(board);

    var valid_count: u8 = 0;
    var valid_boards: [4]Board = undefined;
    inline for (0..4) |dir| {
        if (moves[dir].data != board.data) {
            valid_boards[valid_count] = moves[dir];
            valid_count += 1;
        }
    }
    if (valid_count == 0) return -1;

    var bfs = engine.Bfs.new(state.bfs_buf, &state.move_table);
    const depth = bfs.expand(valid_boards[0..valid_count]).depth + 1;

    const expect = ExpectimaxCache{
        .move_table = &state.move_table,
        .heuristic = state.heuristic,
        .cache = &state.cache,
    };
    const search_fn = expect.reset();
    const dir = search_fn.call(board, depth) orelse return -1;
    return @intCast(dir);
}

fn handleClient(fd: i32, state: *ThreadState) void {
    var req_buf: [32768]u8 = undefined;
    const n = readAll(fd, &req_buf);
    if (n == 0) {
        os.close(fd);
        return;
    }

    const req = req_buf[0..n];

    // GET /health
    if (std.mem.startsWith(u8, req, "GET /health") or std.mem.startsWith(u8, req, "HEAD /health")) {
        const body = "{\"status\":\"ok\",\"version\":\"1.0.0\"}";
        var header_buf: [256]u8 = undefined;
        const header = std.fmt.bufPrint(&header_buf, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n", .{body.len}) catch "";
        writeAll(fd, header);
        writeAll(fd, body);
        os.close(fd);
        return;
    }

    // OPTIONS
    if (std.mem.startsWith(u8, req, "OPTIONS")) {
        const header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n";
        writeAll(fd, header);
        os.close(fd);
        return;
    }

    // POST /search
    if (std.mem.startsWith(u8, req, "POST /search")) {
        const json_start = findJsonStart(req);
        const json = req[json_start..];

        if (parseBoardField(json)) |board_val| {
            const dir = doSearch(state, board_val);
            var body_buf: [256]u8 = undefined;
            const body = std.fmt.bufPrint(&body_buf, "{{\"direction\":{d},\"board\":{d}}}", .{ dir, board_val }) catch "{}";
            var header_buf: [256]u8 = undefined;
            const header = std.fmt.bufPrint(&header_buf, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n", .{body.len}) catch "";
            writeAll(fd, header);
            writeAll(fd, body);
            os.close(fd);
            return;
        }

        if (parseCellsField(json)) |cells| {
            const board_val = cellsToBoard(&cells);
            const dir = doSearch(state, board_val);
            var body_buf: [256]u8 = undefined;
            const body = std.fmt.bufPrint(&body_buf, "{{\"direction\":{d}}}", .{dir}) catch "{}";
            var header_buf: [256]u8 = undefined;
            const header = std.fmt.bufPrint(&header_buf, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n", .{body.len}) catch "";
            writeAll(fd, header);
            writeAll(fd, body);
            os.close(fd);
            return;
        }

        const body = "{\"error\":\"invalid request, need board or cells\"}";
        var header_buf: [256]u8 = undefined;
        const header = std.fmt.bufPrint(&header_buf, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\n\r\n", .{body.len}) catch "";
        writeAll(fd, header);
        writeAll(fd, body);
        os.close(fd);
        return;
    }

    const body = "{\"error\":\"not found\"}";
    var header_buf: [256]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buf, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\n\r\n", .{body.len}) catch "";
    writeAll(fd, header);
    writeAll(fd, body);
    os.close(fd);
}

const BFS_BUF_SIZE = 838848;

pub fn main() !void {
    const allocator = std.heap.page_allocator;

    const port: u16 = 8000;

    // socket
    const listen_fd = os.socket(os.AF.INET, os.SOCK.STREAM | os.SOCK.CLOEXEC, 0);
    if (listen_fd < 0) return error.SocketFailed;
    const sock_fd: i32 = @intCast(listen_fd);

    // SO_REUSEADDR
    const one: i32 = 1;
    _ = os.setsockopt(sock_fd, os.SOL.SOCKET, os.SO.REUSEADDR, @ptrCast(&one), @sizeOf(i32));

    var addr: std.posix.sockaddr.in = .{
        .family = os.AF.INET,
        .port = @byteSwap(port),
        .addr = 0, // 0.0.0.0
    };
    _ = std.mem.zeroes([8]u8);

    if (os.bind(sock_fd, @ptrCast(&addr), @sizeOf(@TypeOf(addr))) != 0) {
        os.close(sock_fd);
        return error.BindFailed;
    }

    if (os.listen(sock_fd, 128) != 0) {
        os.close(sock_fd);
        return error.ListenFailed;
    }

    std.debug.print("2048 AI HTTP Server listening on 0.0.0.0:{d}\n", .{port});

    // 分配线程状态 + BFS buffer
    const state_ptr = try allocator.create(ThreadState);
    const board_buf_ptr = try allocator.alloc(Board, BFS_BUF_SIZE);

    state_ptr.move_table.init();
    state_ptr.heuristic.init();
    @memset(&state_ptr.cache.boards, 0);
    @memset(&state_ptr.cache.depths, 0);
    @memset(&state_ptr.cache.scores, 0);
    state_ptr.bfs_buf = board_buf_ptr;

    while (true) {
        var client_addr: std.posix.sockaddr.in = undefined;
        var addr_len: std.posix.socklen_t = @sizeOf(std.posix.sockaddr.in);
        const client_fd_raw = os.accept(sock_fd, @ptrCast(&client_addr), &addr_len, 0);
        if (client_fd_raw < 0) continue;
        const client_fd: i32 = @intCast(client_fd_raw);

        handleClient(client_fd, state_ptr);
    }
}
