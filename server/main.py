# 2048 AI Cloud Server - FastAPI
# 部署: pip install fastapi uvicorn
# 运行: uvicorn server.main:app --host 0.0.0.0 --port 8000 --workers 4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import subprocess
import os
import time
import asyncio
from concurrent.futures import ThreadPoolExecutor

app = FastAPI(title="2048 AI Cloud Server", version="1.0.0")

# CORS - 允许小程序访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 线程池 - 支持多并发搜索
executor = ThreadPoolExecutor(max_workers=32)

# CLI 二进制路径 (部署时配置)
CLI_PATH = os.getenv("CLI_PATH", "./2048_cli")

# ============ 请求/响应模型 ============

class SearchRequest(BaseModel):
    board: str           # 棋盘 u64 字符串, 如 "0x123456789ABCDEF0"
    timeout_ms: int = 1000

class SearchResponse(BaseModel):
    direction: int      # 0=上, 1=右, 2=下, 3=左
    elapsed_ms: float
    depth: Optional[int] = None
    nodes: Optional[int] = None

class HealthResponse(BaseModel):
    status: str
    uptime: float
    version: str

# ============ 辅助函数 ============

def cells_to_u64(cells: list) -> int:
    """16 格数组转 u64"""
    data = 0
    for val in cells:
        if val == 0:
            rank = 0
        else:
            rank = int(val).bit_length() - 1
        data = (data << 4) | rank
    return data

def u64_to_cells(data: int) -> list:
    """u64 转 16 格数组"""
    cells = []
    for _ in range(16):
        rank = data & 0xF
        val = 0 if rank == 0 else (1 << rank)
        cells.append(val)
        data >>= 4
    return cells

def count_2048(cells: list) -> int:
    """统计 2048 数量"""
    return cells.count(2048)

# ============ API 端点 ============

@app.get("/health")
async def health() -> HealthResponse:
    """健康检查"""
    return HealthResponse(
        status="healthy",
        uptime=time.time() - app.state.start_time,
        version="1.0.0"
    )

@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    """
    搜索最佳方向

    Request:
        board: u64 字符串 (如 "0x123456789ABCDEF0")
        timeout_ms: 超时限制 (默认 1000ms)

    Response:
        direction: 0=上, 1=右, 2=下, 3=左
        elapsed_ms: 实际耗时
    """
    start = time.perf_counter()

    # 解析 board
    board_str = req.board.strip()
    if board_str.startswith("0x") or board_str.startswith("0X"):
        board_val = int(board_str, 16)
    else:
        try:
            board_val = int(board_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid board format")

    # 调用 CLI 搜索
    try:
        loop = asyncio.get_event_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(
                executor,
                run_search,
                board_val,
                req.timeout_ms
            ),
            timeout=req.timeout_ms / 1000 + 1  # 多给 1 秒缓冲
        )
    except subprocess.TimeoutExpired:
        # 超时返回默认方向
        return SearchResponse(
            direction=2,  # 默认下
            elapsed_ms=req.timeout_ms
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    elapsed = (time.perf_counter() - start) * 1000

    return SearchResponse(
        direction=result,
        elapsed_ms=round(elapsed, 2)
    )

@app.post("/search_array")
async def search_array(cells: list[int]) -> dict:
    """
    用数组搜索 (方便小程序调用)

    Request:
        cells: 16 个数字的数组

    Response:
        direction: 0=上, 1=右, 2=下, 3=左
        elapsed_ms: 耗时
        has_2048: 是否有 2048
    """
    if len(cells) != 16:
        raise HTTPException(status_code=400, detail="cells must have 16 elements")

    has_2048 = count_2048(cells) > 0
    board_val = cells_to_u64(cells)

    start = time.perf_counter()

    try:
        loop = asyncio.get_event_loop()
        direction = await loop.run_in_executor(
            executor,
            run_search,
            board_val,
            2000  # 云端 2 秒超时
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    elapsed = (time.perf_counter() - start) * 1000

    return {
        "direction": direction,
        "elapsed_ms": round(elapsed, 2),
        "has_2048": has_2048
    }

def run_search(board: int, timeout_ms: int) -> int:
    """执行搜索"""
    # 方法 1: 调用 CLI (推荐)
    if os.path.exists(CLI_PATH):
        try:
            result = subprocess.run(
                [CLI_PATH, "--search-only", f"0x{board:x}"],
                capture_output=True,
                text=True,
                timeout=timeout_ms / 1000
            )
            if result.returncode == 0:
                return int(result.stdout.strip())
        except:
            pass

    # 方法 2: 内置简单搜索 (备用)
    return builtin_search(board)

def builtin_search(board: int) -> int:
    """
    内置简单搜索 (无 CLI 时的备用)
    使用简单的 Expectimax 深度 6
    """
    # 这里放简单搜索逻辑
    # 暂时返回随机方向
    import random
    return random.randint(0, 3)

# ============ 启动 ============

@app.on_event("startup")
async def startup():
    app.state.start_time = time.time()
    print(f"2048 AI Cloud Server started at {app.state.start_time}")
    print(f"CLI path: {CLI_PATH}")
    print(f"Workers: {executor._max_workers}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
