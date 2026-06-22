const std = @import("std");

pub fn build(b: *std.Build) void {
  const target = b.standardTargetOptions(.{});
  const optimize = b.standardOptimizeOption(.{});
  const strip = optimize == .ReleaseFast or optimize == .ReleaseSmall;

  const engine = b.addModule("engine", .{
    .root_source_file = b.path("src/engine/main.zig"),
  });

  const main_exe = b.addExecutable(.{
    .name = "2048",
    .root_module = b.createModule(.{
      .root_source_file = b.path("src/cli/main.zig"),
      .target = target,
      .optimize = optimize,
      .strip = strip,
      .imports = &.{
        .{
          .name = "engine",
          .module = engine,
        },
      },
    }),
  });

  b.installArtifact(main_exe);

  const main_cmd = b.addRunArtifact(main_exe);
  main_cmd.step.dependOn(b.getInstallStep());

  if (b.args) |args| {
    main_cmd.addArgs(args);
  }

  const main_run = b.step("run", "Run the main application");
  main_run.dependOn(&main_cmd.step);

  const wasm_target = b.resolveTargetQuery(.{
    .cpu_arch = .wasm32,
    .os_tag = .freestanding,
    .cpu_features_add = std.Target.wasm.featureSet(&.{
      .atomics,
      .bulk_memory,
      .extended_const,
      .multivalue,
      .nontrapping_fptoint,
      .sign_ext,
      .simd128,
      .tail_call,
    }),
  });

  const wasm_main = b.addExecutable(.{
    .name = "main",
    .root_module = b.createModule(.{
      .root_source_file = b.path("src/wasm/main.zig"),
      .target = wasm_target,
      .optimize = optimize,
      .strip = strip,
      .imports = &.{
        .{
          .name = "engine",
          .module = engine,
        },
      },
    }),
  });

  wasm_main.rdynamic = true;
  wasm_main.entry = .disabled;
  // 小程序内存: 栈 2MB，数据内存 ~9.6MB，总计 ~11.6MB
  wasm_main.stack_size = 2 * 1024 * 1024;
  const bin = wasm_main.getEmittedBin();
  const artifact = b.addInstallFile(bin, "main.wasm");

  b.getInstallStep().dependOn(&artifact.step);

  // ============ 动态库 ============
  const lib = b.addLibrary(.{
    .name = "lib2048",
    .root_module = b.createModule(.{
      .root_source_file = b.path("src/lib.zig"),
      .target = target,
      .optimize = optimize,
      .strip = strip,
    }),
    .linkage = .dynamic,
  });
  const lib_out = lib.getEmittedBin();
  const lib_install = b.addInstallFile(lib_out, "lib2048.so");
  b.getInstallStep().dependOn(&lib_install.step);

  // ============ 服务器 ============
  const server_exe = b.addExecutable(.{
    .name = "server",
    .root_module = b.createModule(.{
      .root_source_file = b.path("src/server/main.zig"),
      .target = target,
      .optimize = optimize,
      .strip = strip,
      .imports = &.{
        .{
          .name = "engine",
          .module = engine,
        },
      },
    }),
  });

  b.installArtifact(server_exe);

  const server_cmd = b.addRunArtifact(server_exe);
  server_cmd.step.dependOn(b.getInstallStep());
  if (b.args) |args| server_cmd.addArgs(args);
  const server_run = b.step("server", "Run the AI HTTP server");
  server_run.dependOn(&server_cmd.step);
}
