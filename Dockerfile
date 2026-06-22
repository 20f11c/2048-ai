# 2048 AI Cloud Server - Dockerfile
# 多阶段构建: Zig 编译 + Python 运行

# ============ 编译阶段 ============
FROM ghcr.io/ziglang/zig:0.16 as builder

WORKDIR /build
COPY . /build

# 编译 CLI (完整性能版)
RUN zig build -Drelease-fast

# ============ 运行阶段 ============
FROM python:3.11-slim

WORKDIR /app

# 安装 FastAPI 和 uvicorn
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制编译好的 CLI
COPY --from=builder /build/zig-out/bin/2048 /app/2048_cli
RUN chmod +x /app/2048_cli

# 复制服务器代码
COPY server/ .

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/health', timeout=5)"

# 环境变量
ENV CLI_PATH=/app/2048_cli
ENV UVICORN_WORKERS=4

# 暴露端口
EXPOSE 8000

# 启动命令
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
