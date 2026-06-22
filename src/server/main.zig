const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const io = init.io;

    const port: u16 = 9003;
    const addr = std.Io.net.IpAddress.parse("0.0.0.0", port) catch unreachable;
    var server = try std.Io.net.IpAddress.listen(&addr, io, .{ .reuse_address = true });
    defer server.deinit(io);

    std.debug.print("TEST SERVER listening on 0.0.0.0:{d}\n", .{port});

    var count: usize = 0;
    while (count < 5) : (count += 1) {
        const stream = server.accept(io) catch |err| {
            std.debug.print("[{d}] accept error: {}\n", .{ count, err });
            continue;
        };

        std.debug.print("[{d}] accepted, handle={}\n", .{ count, stream.socket.handle });

        // 用 Io.Writer 来写
        var write_buf: [16384]u8 = undefined;
        var w = std.Io.net.Stream.Writer.init(stream, io, &write_buf);

        var read_buf: [16384]u8 = undefined;
        var r = std.Io.net.Stream.Reader.init(stream, io, &read_buf);

        // 先读取
        var req_buf: [8192]u8 = undefined;
        const n = r.interface.readSliceShort(&req_buf) catch |err| {
            std.debug.print("[{d}] read error: {}\n", .{ count, err });
            stream.close(io);
            continue;
        };
        std.debug.print("[{d}] read {d} bytes\n", .{ count, n });

        const response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 13\r\n\r\nHello World\n";
        // 分多次写
        var offset: usize = 0;
        var total_written: usize = 0;
        while (offset < response.len) {
            const n2 = w.interface.write(response[offset..]) catch |err| {
                std.debug.print("[{d}] write error at offset {d}: {}\n", .{ count, offset, err });
                break;
            };
            if (n2 == 0) break;
            offset += n2;
            total_written += n2;
        }

        w.interface.flush() catch |err| {
            std.debug.print("[{d}] flush error: {}\n", .{ count, err });
        };

        std.debug.print("[{d}] wrote total {d} bytes\n", .{ count, total_written });

        stream.close(io);
    }
}
