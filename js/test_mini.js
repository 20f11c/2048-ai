// 小程序风格 WASM AI 基准测试
// 模拟小程序调用链路: 前端维护棋盘 -> encode 为 u64 -> 调用 WASM search() -> 应用方向 -> 填子
// 用法: node js/test_mini.js [局数]
//
// WASM 接口:
//   init()                         -> void        初始化查表
//   search(board: u64)             -> i32         返回方向: 0上 1右 2下 3左, -1无解
//   applyMove(board: u64, dir)     -> u64         应用移动后的新棋盘
//   addRandomTile(board: u64, rng) -> u64         随机空格填子 (rng 高字节决定 2/4, 低字节决定位置)
//   countEmpty(board: u64)         -> u32         返回空格数

const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '..', 'zig-out', 'main.wasm');
const DIR_NAMES = ['↑ 上', '→ 右', '↓ 下', '← 左'];

// === 工具函数: 4x4 棋盘 <-> u64 BigInt 互转 ===
// 棋盘格布局 (row-major, 0~15):
//   [0]  [1]  [2]  [3]
//   [4]  [5]  [6]  [7]
//   [8]  [9]  [10] [11]
//   [12] [13] [14] [15]
// 每格存 log2(value), 即: 空=0, 2=1, 4=2, 8=3, ..., 2048=11
function boardToU64(cells) {
    // cells: 16 个数字, 每个是实际值 0/2/4/8/.../2048
    let data = 0n;
    for (let i = 0; i < 16; i++) {
        const val = cells[i];
        const rank = val === 0 ? 0 : Math.log2(val); // rank 0 = 空
        data <<= 4n;
        data |= BigInt(rank);
    }
    return data;
}

function u64ToBoard(data) {
    const cells = [];
    for (let i = 0; i < 16; i++) {
        // 从高到低: 位置 0 在最高位
        const rank = Number((data >> BigInt(60 - i * 4)) & 0xFn);
        cells.push(rank === 0 ? 0 : (1 << rank));
    }
    return cells;
}

function formatBoard(cells) {
    const lines = [];
    for (let r = 0; r < 4; r++) {
        const row = [];
        for (let c = 0; c < 4; c++) {
            const v = cells[r * 4 + c];
            row.push(v === 0 ? '  . ' : String(v).padStart(4));
        }
        lines.push('|' + row.join('|') + '|');
    }
    return lines.join('\n');
}

function countTilesValue(cells, targetValue) {
    let count = 0;
    for (let i = 0; i < 16; i++) {
        if (cells[i] === targetValue) count++;
    }
    return count;
}

function calcScore(cells) {
    let s = 0;
    for (let i = 0; i < 16; i++) {
        const v = cells[i];
        if (v > 0) s += Math.floor(Math.log2(v)) * v;
    }
    return s;
}

// 简易 LCG 随机数 (与 WASM 内部使用相同种子方式, 但在 JS 侧独立维护)
function makeRNG(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state;
    };
}

// === 一局游戏 ===
function playGame(exports, rng) {
    // 初始: 空棋盘, 填两个初始块
    let board = 0n;
    board = exports.addRandomTile(board, rng());
    board = exports.addRandomTile(board, rng());

    let moves = 0;
    let stuckCount = 0; // 连续无效方向数, 防死循环

    while (true) {
        const dir = exports.search(board);

        if (dir === -1n || dir === -1) {
            // WASM 说无解
            const empty = exports.countEmpty(board);
            if (empty === 0n || empty === 0) {
                // 验证是否真的没方向
                let canMove = false;
                for (let d = 0; d < 4; d++) {
                    const nb = exports.applyMove(board, d);
                    if (nb !== board) { canMove = true; break; }
                }
                if (!canMove) break;
            }
            // WASM 报告 -1 但实际还有空间 -> 容错, 尝试所有方向
            let moved = false;
            for (let d = 0; d < 4; d++) {
                const nb = exports.applyMove(board, d);
                if (nb !== board) {
                    board = exports.addRandomTile(nb, rng());
                    moves++;
                    moved = true;
                    break;
                }
            }
            if (!moved) break;
            continue;
        }

        const newBoard = exports.applyMove(board, dir);
        if (newBoard === board) {
            stuckCount++;
            if (stuckCount > 4) break;
            // 尝试其它方向
            let moved = false;
            for (let d = 0; d < 4; d++) {
                if (d === dir) continue;
                const nb = exports.applyMove(board, d);
                if (nb !== board) {
                    board = exports.addRandomTile(nb, rng());
                    moves++;
                    moved = true;
                    break;
                }
            }
            if (!moved) break;
            continue;
        }

        stuckCount = 0;
        board = exports.addRandomTile(newBoard, rng());
        moves++;
    }

    const finalCells = u64ToBoard(board);
    return {
        moves,
        score: calcScore(finalCells),
        count2048: countTilesValue(finalCells, 2048),
        maxTile: Math.max(...finalCells),
        finalCells,
    };
}

async function main() {
    const numGames = parseInt(process.argv[2] || '10');
    console.log('='.repeat(66));
    console.log(' 2048 AI WASM 基准测试');
    console.log(' 规则: 2048 封顶合并不成, 可并存; 目标 3+ 个 2048');
    console.log(' 测试局数:', numGames);
    console.log('='.repeat(66));

    // --- 加载 WASM ---
    const wasmBytes = fs.readFileSync(WASM_PATH);
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module);
    const exports = instance.exports;

    // --- 验证导出 ---
    const required = ['init', 'search', 'applyMove', 'addRandomTile', 'countEmpty'];
    console.log('\n WASM 导出函数:');
    for (const f of required) {
        const ok = typeof exports[f] === 'function';
        console.log('   ' + (ok ? '✓' : '✗') + ' ' + f);
    }
    console.log(' WASM 文件大小:', (wasmBytes.length / 1024).toFixed(2), 'KB');

    // --- 初始化 ---
    exports.init();
    console.log('\n WASM 初始化完成');

    // --- 跑多局 ---
    const rng = makeRNG(0xDEADBEEF);
    let totalMoves = 0;
    let totalScore = 0;
    let gamesWith3Plus = 0;
    let gamesWith2Plus = 0;
    let gamesWith1Plus = 0;
    let bestScore = 0;
    let bestGame = null;
    let best2048Count = 0;

    console.log('\n 开始对局...\n');

    const t0 = Date.now();

    for (let g = 0; g < numGames; g++) {
        const result = playGame(exports, rng);
        totalMoves += result.moves;
        totalScore += result.score;
        if (result.count2048 >= 3) gamesWith3Plus++;
        if (result.count2048 >= 2) gamesWith2Plus++;
        if (result.count2048 >= 1) gamesWith1Plus++;
        if (result.score > bestScore) { bestScore = result.score; bestGame = result; }
        if (result.count2048 > best2048Count) best2048Count = result.count2048;

        const flag = result.count2048 >= 3 ? '★' : (result.count2048 >= 1 ? ' ' : '·');
        console.log(
            '  ' + flag + ' 局 ' + String(g + 1).padStart(3) +
            ' | 得分 ' + String(result.score).padStart(6) +
            ' | 步数 ' + String(result.moves).padStart(4) +
            ' | 2048×' + result.count2048 +
            ' | 最大 ' + String(result.maxTile).padStart(5)
        );
    }

    const elapsed = Date.now() - t0;

    // --- 汇总 ---
    console.log('\n' + '='.repeat(66));
    console.log(' 统计汇总');
    console.log('='.repeat(66));
    console.log(' 总局数           : ' + numGames);
    console.log(' 总耗时           : ' + (elapsed / 1000).toFixed(1) + ' 秒');
    console.log(' 平均每步耗时     : ' + (elapsed / totalMoves).toFixed(2) + ' ms');
    console.log(' 平均步数/局      : ' + (totalMoves / numGames).toFixed(1));
    console.log(' 平均得分         : ' + (totalScore / numGames).toFixed(0));
    console.log(' 最高得分         : ' + bestScore);
    console.log(' 单局最高 2048 数 : ' + best2048Count);
    console.log('');
    console.log(' 达成率:');
    console.log('   ≥1 个 2048  : ' + gamesWith1Plus + '/' + numGames +
        '  (' + (gamesWith1Plus / numGames * 100).toFixed(1) + '%)');
    console.log('   ≥2 个 2048  : ' + gamesWith2Plus + '/' + numGames +
        '  (' + (gamesWith2Plus / numGames * 100).toFixed(1) + '%)');
    console.log('   ≥3 个 2048  : ' + gamesWith3Plus + '/' + numGames +
        '  (' + (gamesWith3Plus / numGames * 100).toFixed(1) + '%)');

    if (bestGame) {
        console.log('\n 最佳终局棋盘:');
        console.log(' ' + '-'.repeat(37));
        console.log(' ' + formatBoard(bestGame.finalCells).split('\n').join('\n '));
        console.log(' ' + '-'.repeat(37));
        console.log(' 得分: ' + bestGame.score + ' | 2048 数量: ' + bestGame.count2048 + ' | 步数: ' + bestGame.moves);
    }
    console.log('='.repeat(66));
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
