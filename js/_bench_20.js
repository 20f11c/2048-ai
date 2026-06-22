// 20 局详细 benchmark
const fs = require('fs');

(async function() {
    const wasmBytes = fs.readFileSync('./zig-out/main.wasm');
    const result = await WebAssembly.instantiate(wasmBytes);
    const exports = result.instance.exports;

    console.log('='.repeat(78));
    console.log(' WASM 2048 AI 详细测试 | 20 局完整游戏 | 8MB 栈 | 524K BFS | engine.Bfs');
    console.log('='.repeat(78));
    
    exports.init();

    const TOTAL = 20;
    const stats = {
        totalMoves: 0,
        totalTime: 0,
        maxTile: [],
        count2048: [],
        games: [],
        distribution: { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0, 10:0, 11:0, 12:0, 13:0, 14:0, 15:0, 16:0 }
    };

    const t0 = Date.now();
    for (let game = 0; game < TOTAL; game++) {
        let board = 0n;
        board = exports.addRandomTile(board, Math.floor(Math.random() * 0xFFFFFFFF));
        board = exports.addRandomTile(board, Math.floor(Math.random() * 0xFFFFFFFF));

        let moves = 0;
        let searchTime = 0;

        while (true) {
            const t1 = Date.now();
            const dir = exports.search(board);
            searchTime += Date.now() - t1;
            
            if (dir === -1n || dir === -1) {
                let valid = false;
                for (let d = 0; d < 4; d++) {
                    const nb = exports.applyMove(board, d);
                    if (nb !== board) { valid = true; break; }
                }
                if (!valid) break;
                for (let d = 0; d < 4; d++) {
                    const nb = exports.applyMove(board, d);
                    if (nb !== board) {
                        board = exports.addRandomTile(nb, Math.floor(Math.random() * 0xFFFFFFFF));
                        moves++;
                        break;
                    }
                }
                continue;
            }

            const nb = exports.applyMove(board, Number(dir));
            if (nb === board) continue;
            board = exports.addRandomTile(nb, Math.floor(Math.random() * 0xFFFFFFFF));
            moves++;
        }

        let count2048 = 0;
        let maxRank = 0;
        for (let i = 0; i < 16; i++) {
            const rank = Number((board >> BigInt(60 - i * 4)) & 0xFn);
            if (rank === 11) count2048++;
            if (rank > maxRank) maxRank = rank;
        }
        const maxTile = maxRank === 0 ? 0 : (1 << maxRank);

        stats.totalMoves += moves;
        stats.totalTime += searchTime;
        stats.maxTile.push(maxTile);
        stats.count2048.push(count2048);
        stats.distribution[count2048]++;
        stats.games.push({ game: game+1, moves, count2048, maxTile, avgTime: (searchTime/moves).toFixed(1) });

        const stars = '★'.repeat(Math.min(5, Math.max(0, count2048 - 2)));
        const color = count2048 >= 3 ? '\x1b[32m' : count2048 >= 2 ? '\x1b[33m' : '\x1b[31m';
        console.log(`${color}  [${String(game+1).padStart(2)}] 步数=${String(moves).padStart(5)}  最大=${String(maxTile).padStart(5)}  2048×${count2048}  平均${(searchTime/moves).toFixed(1)}ms  ${stars}\x1b[0m`);
    }

    const elapsed = (Date.now() - t0) / 1000;
    const avgMoves = stats.totalMoves / TOTAL;
    const avgTimePerMove = stats.totalTime / stats.totalMoves;

    console.log('\n' + '='.repeat(78));
    console.log(' 统计汇总');
    console.log('='.repeat(78));
    console.log(` 总局数           : ${TOTAL}`);
    console.log(` 总耗时           : ${elapsed.toFixed(1)}s`);
    console.log(` 总步数           : ${stats.totalMoves}`);
    console.log(` 平均步数/局      : ${avgMoves.toFixed(0)}`);
    console.log(` 平均搜索耗时/步  : ${avgTimePerMove.toFixed(2)}ms`);
    console.log(` 平均总耗时/局    : ${(elapsed/TOTAL*1000).toFixed(0)}ms`);
    console.log('');
    console.log(' 2048 数量分布:');
    for (let i = 0; i <= 16; i++) {
        if (stats.distribution[i] > 0) {
            console.log(`   ${i} 个 2048 : ${stats.distribution[i]} 局 (${(stats.distribution[i]/TOTAL*100).toFixed(1)}%)`);
        }
    }
    console.log('');
    console.log(' 达成率:');
    const score1 = stats.count2048.filter(c => c >= 1).length;
    const score2 = stats.count2048.filter(c => c >= 2).length;
    const score3 = stats.count2048.filter(c => c >= 3).length;
    const score4 = stats.count2048.filter(c => c >= 4).length;
    const score5 = stats.count2048.filter(c => c >= 5).length;
    console.log(`   ≥1 个 2048  : ${score1}/${TOTAL}  (${(score1/TOTAL*100).toFixed(1)}%)`);
    console.log(`   ≥2 个 2048  : ${score2}/${TOTAL}  (${(score2/TOTAL*100).toFixed(1)}%)`);
    console.log(`   ≥3 个 2048  : ${score3}/${TOTAL}  (${(score3/TOTAL*100).toFixed(1)}%)`);
    console.log(`   ≥4 个 2048  : ${score4}/${TOTAL}  (${(score4/TOTAL*100).toFixed(1)}%)`);
    console.log(`   ≥5 个 2048  : ${score5}/${TOTAL}  (${(score5/TOTAL*100).toFixed(1)}%)`);
    console.log('');
    console.log(' 每局详情:');
    console.log(' ┌────┬────────┬────────┬───────┬─────────┐');
    console.log(' │ 局 │  步数  │ 最大块 │ 2048数 │ 平均耗时 │');
    console.log(' ├────┼────────┼────────┼───────┼─────────┤');
    stats.games.forEach(g => {
        console.log(` │ ${String(g.game).padStart(2)} │ ${String(g.moves).padStart(6)} │ ${String(g.maxTile).padStart(6)} │ ${String(g.count2048).padStart(5)} │ ${g.avgTime.padStart(7)}ms │`);
    });
    console.log(' └────┴────────┴────────┴───────┴─────────┘');
    console.log('='.repeat(78));
})();
