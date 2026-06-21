// 2048 AI —— 微信小程序 WASM 接入层
//
// 用法:
//   const ai = require('../../utils/ai2048.js');
//   ai.init('./utils/main.wasm', () => {
//     // 就绪
//     const dir = ai.search(cells);   // cells: 16 个数字的数组
//     const newBoard = ai.applyMove(cells, dir);
//     const afterTile = ai.addRandomTile(newBoard, Math.floor(Math.random() * 0xFFFFFFFF));
//   });
//
// 棋盘坐标 (row-major, 0~15):
//   [ 0] [ 1] [ 2] [ 3]
//   [ 4] [ 5] [ 6] [ 7]
//   [ 8] [ 9] [10] [11]
//   [12] [13] [14] [15]
//
// 方向编号: 0=上, 1=右, 2=下, 3=左, -1=无解

const DIR_NAME = ['↑ 上', '→ 右', '↓ 下', '← 左'];

let instance_ = null;
let exports_ = null;
let ready_ = false;

/**
 * 初始化 WASM
 * @param {string} wasmPath - main.wasm 的相对路径 (小程序里请放在包内静态资源)
 * @param {function} onReady - 初始化完成回调
 */
function init(wasmPath, onReady) {
  if (ready_) {
    onReady && onReady();
    return;
  }

  // 小程序环境: wx.getFileSystemManager
  // 浏览器环境: fetch + WebAssembly
  // Node 环境: fs + WebAssembly
  const load = () => {
    if (typeof wx !== 'undefined' && wx.getFileSystemManager) {
      // --- 微信小程序 ---
      const fs = wx.getFileSystemManager();
      try {
        // wasm 文件要放在小程序包内 (比如放在 utils/main.wasm)
        const data = fs.readFileSync(wasmPath, 'binary');
        WebAssembly.compile(data).then(module => {
          return WebAssembly.instantiate(module);
        }).then(inst => {
          instance_ = inst;
          exports_ = inst.exports;
          exports_.init();
          ready_ = true;
          onReady && onReady();
        }).catch(err => {
          console.error('AI WASM 初始化失败:', err);
        });
      } catch (err) {
        console.error('读取 WASM 文件失败:', err);
      }
    } else if (typeof require !== 'undefined' && typeof module !== 'undefined') {
      // --- Node.js ---
      try {
        const fs = require('fs');
        const data = fs.readFileSync(wasmPath);
        WebAssembly.instantiate(data).then(result => {
          instance_ = result.instance || result;
          exports_ = instance_.exports;
          exports_.init();
          ready_ = true;
          onReady && onReady();
        }).catch(err => {
          console.error('AI WASM 初始化失败:', err);
        });
      } catch (err) {
        console.error('读取 WASM 文件失败:', err);
      }
    } else if (typeof fetch !== 'undefined' && typeof WebAssembly !== 'undefined') {
      // --- 浏览器 ---
      fetch(wasmPath)
        .then(resp => resp.arrayBuffer())
        .then(buf => WebAssembly.instantiate(buf))
        .then(result => {
          instance_ = result.instance || result;
          exports_ = instance_.exports;
          exports_.init();
          ready_ = true;
          onReady && onReady();
        })
        .catch(err => {
          console.error('AI WASM 初始化失败:', err);
        });
    } else {
      console.error('当前环境不支持 WASM');
    }
  };

  load();
}

/**
 * 将 16 格棋盘数组 编码为 u64 BigInt
 * cells: [0, 0, 2, 4, ...] 长度 16
 */
function cellsToU64(cells) {
  let data = 0n;
  for (let i = 0; i < 16; i++) {
    const val = cells[i] || 0;
    const rank = val === 0 ? 0 : Math.floor(Math.log2(val));
    data = (data << 4n) | BigInt(rank);
  }
  return data;
}

/**
 * 将 u64 BigInt 解码为 16 格棋盘数组
 */
function u64ToCells(data) {
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const rank = Number((data >> BigInt(60 - i * 4)) & 0xFn);
    cells.push(rank === 0 ? 0 : (1 << rank));
  }
  return cells;
}

/**
 * 搜索当前最佳走法
 * @param {number[]} cells - 16 格棋盘
 * @returns {number} 方向: 0上 1右 2下 3左, -1 无解
 */
function search(cells) {
  if (!ready_ || !exports_) return -1;
  const data = cellsToU64(cells);
  return Number(exports_.search(data));
}

/**
 * 应用一次移动 (不填子)
 * @param {number[]} cells - 16 格棋盘
 * @param {number} dir - 方向 (0~3)
 * @returns {number[]} 移动后的 16 格棋盘
 */
function applyMove(cells, dir) {
  if (!ready_ || !exports_) return cells.slice();
  const data = cellsToU64(cells);
  const newData = exports_.applyMove(data, dir >>> 0);
  return u64ToCells(newData);
}

/**
 * 随机空格填一个 2 或 4 (90% / 10%)
 * @param {number[]} cells - 16 格棋盘
 * @param {number} rngVal - 32 位随机数
 * @returns {number[]} 填子后的 16 格棋盘
 */
function addRandomTile(cells, rngVal) {
  if (!ready_ || !exports_) return cells.slice();
  const data = cellsToU64(cells);
  const newData = exports_.addRandomTile(data, (rngVal >>> 0));
  return u64ToCells(newData);
}

/**
 * 返回棋盘空格数
 */
function countEmpty(cells) {
  if (!ready_ || !exports_) return 0;
  const data = cellsToU64(cells);
  return Number(exports_.countEmpty(data));
}

/**
 * 返回方向文字描述
 */
function dirName(dir) {
  if (dir === -1) return '无解';
  return DIR_NAME[dir & 3] || '?';
}

/**
 * 是否已就绪
 */
function isReady() {
  return ready_;
}

module.exports = {
  init,
  search,
  applyMove,
  addRandomTile,
  countEmpty,
  dirName,
  isReady,
};
