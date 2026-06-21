// 2048 WASM 基准测试 —— 极简接口版
// 用法: node js/test_step.js [游戏局数]
// WASM 接口: init() + step(u64 board) -> u64 newBoard

const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '..', 'zig-out', 'main.wasm');

function boardToString(bigint) {
  const rows = [];
  for (let r = 0; r < 4; r++) {
    const cells = [];
    for (let c = 0; c < 4; c++) {
      const shift = BigInt(60 - (r * 4 + c) * 4);
      const rank = Number((bigint >> shift) & 0xFn);
      const val = rank === 0 ? '  . ' : String(1 << rank).padStart(4);
      cells.push(val);
    }
    rows.push(cells.join(' '));
  }
  return rows.join('\n');
}

function analyzeBoard(bigint) {
  let count2048 = 0;
  let maxRank = 0;
  let score = 0;
  let b = bigint;
  for (let i = 0; i < 16; i++) {
    const rank = Number((b >> BigInt(60 - i * 4)) & 0xFn);
    if (rank === 11) count2048++;
    if (rank > maxRank) maxRank = rank;
    if (rank > 0) score += (rank - 1) * (1 << rank);
    b <<= 4n;
  }
  return { count2048, maxVal: maxRank === 0 ? 0 : (1 << maxRank), score };
}

function runGame(instance) {
  let board = instance.exports.step(0n); // 新游戏
  let moves = 0;
  const start = process.hrtime.bigint();
  while (true) {
    const newBoard = instance.exports.step(board);
    if (newBoard === board) break;
    board = newBoard;
    moves++;
  }
  const end = process.hrtime.bigint();
  return {
    finalBoard: board,
    moves,
    elapsedMs: Number(end - start) / 1e6,
  };
}

async function main() {
  const numGames = parseInt(process.argv[2] || '5');

  console.log('='.repeat(60));
  console.log('WASM 极简版基准测试 (接口: init() + step())');
  console.log('游戏规则: 2048 封顶, 不合并');
  console.log('测试局数:', numGames);
  console.log('='.repeat(60));

  const bytes = fs.readFileSync(WASM_PATH);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module);

  console.log('\n[1/2] 初始化...');
  instance.exports.init();
  console.log('      OK');
  console.log('      WASM 文件:', (bytes.length / 1024).toFixed(2), 'KB');
  console.log(`[2/2] 运行 ${numGames} 局游戏...\n`);

  let totalMoves = 0;
  let totalTime = 0;
  let totalScore = 0;
  let bestScore = 0;
  let bestBoard = null;
  let best2048Count = 0;
  let total2048Games = 0;
  const t2048Dist = {};

  for (let g = 0; g < numGames; g++) {
    const result = runGame(instance);
    const stat = analyzeBoard(result.finalBoard);

    totalMoves += result.moves;
    totalTime += result.elapsedMs;
    totalScore += stat.score;

    if (stat.score > bestScore) {
      bestScore = stat.score;
      bestBoard = result.finalBoard;
    }
    if (stat.count2048 > best2048Count) best2048Count = stat.count2048;
    if (stat.maxVal >= 2048) total2048Games++;

    t2048Dist[stat.count2048] = (t2048Dist[stat.count2048] || 0) + 1;

    const speed = result.moves / (result.elapsedMs / 1000);
    console.log(
      `[局 ${String(g + 1).padStart(2)}] ` +
      `得分=${String(stat.score).padStart(6)} | ` +
      `步数=${String(result.moves).padStart(4)} | ` +
      `2048×${stat.count2048} | ` +
      `${speed.toFixed(0)}步/秒`
    );
  }

  console.log('\n' + '='.repeat(60));
  console.log('  结果汇总');
  console.log('='.repeat(60));
  console.log(`  总局数          : ${numGames}`);
  console.log(`  平均得分        : ${(totalScore / numGames).toFixed(0)}`);
  console.log(`  最高得分        : ${bestScore}`);
  console.log(`  平均步数        : ${(totalMoves / numGames).toFixed(1)}`);
  console.log(`  平均搜索速度    : ${(totalMoves / (totalTime / 1000)).toFixed(0)} 步/秒`);
  console.log(`  每步平均耗时    : ${(totalTime / totalMoves).toFixed(2)} ms`);
  console.log(`  2048 到达率     : ${(total2048Games / numGames * 100).toFixed(1)}%`);
  console.log(`  单局最高 2048数 : ${best2048Count}`);
  console.log('  2048 数量分布  :');
  for (const k of Object.keys(t2048Dist).sort((a, b) => Number(a) - Number(b))) {
    const pct = (t2048Dist[k] / numGames * 100).toFixed(1);
    console.log(`     ${k} 个: ${t2048Dist[k]} 局 (${pct}%)`);
  }

  if (bestBoard !== null) {
    console.log('\n  最高得分局终局棋盘:');
    console.log('  ' + '-'.repeat(35));
    console.log('  ' + boardToString(bestBoard).split('\n').join('\n  '));
    console.log('  ' + '-'.repeat(35));
  }
  console.log('='.repeat(60));
  console.log('\n✅ 小程序适配: WASM 只导出 init() + step() 两个函数');
  console.log('✅ 运行时无外部依赖,可直接放入 WebView/WASM 环境');
}

main().catch(err => {
  console.error('错误:', err);
  process.exit(1);
});
