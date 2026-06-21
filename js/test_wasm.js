const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '..', 'zig-out', 'main.wasm');

function formatBoard(board) {
    const rows = [];
    let b = board;
    for (let r = 0; r < 4; r++) {
        const cells = [];
        for (let c = 0; c < 4; c++) {
            const rank = Number((b >> 60n) & 0xFn);
            const val = rank === 0 ? 0 : (1 << rank);
            cells.push(val.toString().padStart(6));
            b <<= 4n;
        }
        rows.push('|' + cells.join('|') + '|');
    }
    const line = '+------+------+------+------+';
    return [line, ...rows.map(r => r), line].join('\n');
}

function rankToValue(rank) {
    return rank === 0 ? 0 : (1 << rank);
}

class Game2048 {
    constructor(wasmExports, seed = Date.now()) {
        this.exports = wasmExports;
        this.rng = seed >>> 0;
    }

    nextRand() {
        this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
        return this.rng;
    }

    newGame() {
        let board = 0n;
        board = this.exports.addRandomTile(board, this.nextRand());
        board = this.exports.addRandomTile(board, this.nextRand());
        return board;
    }

    playGame(maxMoves = 10000) {
        let board = this.newGame();
        const moves = [];
        let totalSearchTime = 0;

        while (moves.length < maxMoves) {
            const t1 = process.hrtime.bigint();
            const dir = this.exports.search(board);
            const t2 = process.hrtime.bigint();
            totalSearchTime += Number(t2 - t1);

            if (dir === -1) break;

            const moved = this.exports.applyMove(board, dir);
            if (moved === board) break;

            board = this.exports.addRandomTile(moved, this.nextRand());
            moves.push(dir);
        }

        return {
            finalBoard: board,
            moves: moves.length,
            totalSearchTimeNs: totalSearchTime,
            maxTile: Number(this.exports.maxTile(board)),
            count2048: Number(this.exports.countRank(board, 11)),
        };
    }
}

async function runBenchmark(numGames = 5, seed = 12345) {
    const wasmBytes = fs.readFileSync(WASM_PATH);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(wasmModule);
    const wasmExports = instance.exports;

    console.log('='.repeat(60));
    console.log('WASM 版 2048 AI 基准测试');
    console.log('游戏局数:', numGames);
    console.log('PRNG 种子:', seed);
    console.log('规则: 2048 封顶, 不合并');
    console.log('='.repeat(60));

    console.log('\n[初始化] 调用 init() 预计算移动表和启发式表...');
    wasmExports.init();
    console.log('[完成] 初始化 OK');

    const game = new Game2048(wasmExports, seed);

    let totalScore = 0;
    let totalMoves = 0;
    let totalSearchTime = 0;
    let maxScore = 0;
    let bestResult = null;
    const reachCount = { '2': 0, '4': 0, '8': 0, '16': 0, '32': 0, '64': 0, '128': 0, '256': 0, '512': 0, '1024': 0, '2048': 0 };
    const count2048Hist = {};

    for (let i = 0; i < numGames; i++) {
        const result = game.playGame();

        const boardVal = result.finalBoard;
        let score = 0;
        let b = boardVal;
        for (let j = 0; j < 16; j++) {
            const rank = Number((b >> 60n) & 0xFn);
            if (rank > 0) {
                score += (rank - 1) * (1 << rank);
            }
            b <<= 4n;
        }

        totalScore += score;
        totalMoves += result.moves;
        totalSearchTime += result.totalSearchTimeNs;
        if (score > maxScore) {
            maxScore = score;
            bestResult = result;
        }

        const maxTileVal = rankToValue(result.maxTile);
        for (const key in reachCount) {
            if (parseInt(key) <= maxTileVal) reachCount[key]++;
        }

        const c = result.count2048;
        count2048Hist[c] = (count2048Hist[c] || 0) + 1;

        const movesPerSec = result.moves / (result.totalSearchTimeNs / 1e9);
        console.log(
            `[第 ${(i + 1).toString().padStart(3)} 局] ` +
            `得分=${score.toString().padStart(6)} | ` +
            `步数=${result.moves.toString().padStart(4)} | ` +
            `最大=${maxTileVal.toString().padStart(5)} | ` +
            `2048×${c} | ` +
            `${movesPerSec.toFixed(1)}步/s`
        );
    }

    console.log('\n' + '='.repeat(60));
    console.log('  统计汇总');
    console.log('='.repeat(60));
    console.log(`  总局数       : ${numGames}`);
    console.log(`  平均得分     : ${(totalScore / numGames).toFixed(1)}`);
    console.log(`  最高得分     : ${maxScore}`);
    console.log(`  平均步数     : ${(totalMoves / numGames).toFixed(1)}`);
    console.log(`  平均搜索速度 : ${(totalMoves / (totalSearchTime / 1e9)).toFixed(1)} 步/秒`);
    console.log('');
    console.log('  达到率:');
    for (const key of Object.keys(reachCount)) {
        const pct = (reachCount[key] / numGames * 100).toFixed(1).padStart(5);
        console.log(`    ${key.padStart(5)} : ${reachCount[key]}/${numGames} (${pct}%)`);
    }
    console.log('');
    console.log('  2048 数量分布:');
    const keys = Object.keys(count2048Hist).map(Number).sort((a, b) => a - b);
    for (const k of keys) {
        console.log(`    ${k} 个 2048 : ${count2048Hist[k]} 局 (${(count2048Hist[k] / numGames * 100).toFixed(1)}%)`);
    }

    if (bestResult) {
        console.log('');
        console.log('  最佳终局 (得分最高):');
        console.log(formatBoard(bestResult.finalBoard));
        console.log(`  最大格子: ${rankToValue(bestResult.maxTile)} | 2048 数量: ${bestResult.count2048}`);
    }
    console.log('='.repeat(60));
}

const args = process.argv.slice(2);
const numGames = parseInt(args[0] || '5');
const seed = parseInt(args[1] || '12345');

runBenchmark(numGames, seed).catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
