// 2048 AI —— 统一接口，支持 WASM 和云端静默切换
//
// 策略:
//   - 棋盘不含 2048 → 使用 WASM (小程序本地计算)
//   - 棋盘含 2048  → 使用云端 API (高性能服务器)
//   - 云端不可用时自动降级到 WASM
//
// 用法:
//   const ai = require('../../utils/ai2048.js');
//   ai.init('./utils/main.wasm', 'https://your-server.com/api', () => {
//     const dir = ai.search(cells);  // 自动选择引擎
//   });
//
// 接口:
//   ai.init(wasmPath, apiUrl, onReady)     // 初始化
//   ai.search(cells)                       // 搜索方向
//   ai.applyMove(cells, dir)               // 应用移动
//   ai.addRandomTile(cells, rng)           // 添加随机块
//   ai.countEmpty(cells)                   // 空格数
//   ai.has2048(cells)                     // 检测 2048
//   ai.isReady()                           // 是否就绪
//   ai.setEngine(engine)                   // 强制使用指定引擎 ('wasm' | 'cloud')

const DIR_NAME = ['↑ 上', '→ 右', '↓ 下', '← 左'];

// ============ 引擎状态 ============
let wasmInstance = null;
let wasmExports = null;
let cloudBaseUrl = null;
let cloudAvailable = false;
let cloudReady = false;
let ready = false;
let forcedEngine = null; // 'wasm' | 'cloud' | null

// ============ 工具函数 ============

function cellsToU64(cells) {
    let data = 0n;
    for (let i = 0; i < 16; i++) {
        const val = cells[i] || 0;
        const rank = val === 0 ? 0 : Math.floor(Math.log2(val));
        data = (data << 4n) | BigInt(rank);
    }
    return data;
}

function u64ToCells(data) {
    const cells = [];
    for (let i = 0; i < 16; i++) {
        const rank = Number((data >> BigInt(60 - i * 4)) & 0xFn);
        cells.push(rank === 0 ? 0 : (1 << rank));
    }
    return cells;
}

/**
 * 检测棋盘是否包含 2048
 */
function detect2048(cells) {
    return cells.some(v => v === 2048);
}

/**
 * 检测棋盘是否有有效移动
 */
function hasValidMove(cells) {
    if (wasmExports) {
        const data = cellsToU64(cells);
        for (let d = 0; d < 4; d++) {
            if (wasmExports.applyMove(data, d) !== data) return true;
        }
    }
    return false;
}

// ============ 引擎选择 ============

/**
 * 选择使用哪个引擎
 * @returns {'wasm' | 'cloud'}
 */
function selectEngine(cells) {
    if (forcedEngine) return forcedEngine;
    if (!cloudAvailable || !cloudReady) return 'wasm';
    if (detect2048(cells)) return 'cloud';
    return 'wasm';
}

// ============ WASM 引擎 ============

function initWasm(wasmPath, onReady) {
    const load = () => {
        if (typeof wx !== 'undefined' && wx.getFileSystemManager) {
            // --- 微信小程序 ---
            const fs = wx.getFileSystemManager();
            try {
                const data = fs.readFileSync(wasmPath, 'binary');
                WebAssembly.compile(data).then(module => {
                    return WebAssembly.instantiate(module);
                }).then(inst => {
                    wasmInstance = inst;
                    wasmExports = inst.exports;
                    wasmExports.init();
                    ready = true;
                    onReady && onReady();
                }).catch(err => {
                    console.error('WASM 初始化失败:', err);
                    ready = !!wasmExports;
                    onReady && onReady();
                });
            } catch (err) {
                console.error('读取 WASM 文件失败:', err);
                ready = !!wasmExports;
                onReady && onReady();
            }
        } else if (typeof require !== 'undefined' && typeof module !== 'undefined') {
            // --- Node.js ---
            try {
                const fs = require('fs');
                const data = fs.readFileSync(wasmPath);
                WebAssembly.instantiate(data).then(result => {
                    wasmInstance = result.instance || result;
                    wasmExports = wasmInstance.exports;
                    wasmExports.init();
                    ready = true;
                    onReady && onReady();
                }).catch(err => {
                    console.error('WASM 初始化失败:', err);
                    ready = !!wasmExports;
                    onReady && onReady();
                });
            } catch (err) {
                console.error('WASM 初始化失败:', err);
                ready = !!wasmExports;
                onReady && onReady();
            }
        } else if (typeof fetch !== 'undefined') {
            // --- 浏览器 ---
            fetch(wasmPath)
                .then(resp => resp.arrayBuffer())
                .then(buf => WebAssembly.instantiate(buf))
                .then(result => {
                    wasmInstance = result.instance || result;
                    wasmExports = wasmInstance.exports;
                    wasmExports.init();
                    ready = true;
                    onReady && onReady();
                })
                .catch(err => {
                    console.error('WASM 初始化失败:', err);
                    ready = !!wasmExports;
                    onReady && onReady();
                });
        } else {
            ready = false;
            onReady && onReady();
        }
    };
    load();
}

// ============ 云端引擎 ============

async function cloudSearch(cells) {
    if (!cloudAvailable || !cloudReady) return -1;
    try {
        const response = await fetch(`${cloudBaseUrl}/search_array`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cells),
        });
        if (!response.ok) return -1;
        const result = await response.json();
        return result.direction;
    } catch (err) {
        console.warn('云端搜索失败，降级到 WASM:', err);
        cloudAvailable = false;
        return -1;
    }
}

// 云端健康检查
async function checkCloudHealth() {
    if (!cloudBaseUrl) return;
    try {
        const response = await fetch(`${cloudBaseUrl}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });
        cloudReady = response && response.ok;
    } catch (err) {
        cloudReady = false;
    }
}

// ============ 主接口 ============

/**
 * 初始化 AI 引擎
 * @param {string} wasmPath - WASM 文件路径
 * @param {string} apiUrl - 云端 API 基础 URL
 * @param {function} onReady - 就绪回调
 */
function init(wasmPath, apiUrl, onReady) {
    cloudBaseUrl = apiUrl;
    cloudAvailable = !!apiUrl;

    // 先检查云端健康
    if (cloudAvailable) {
        checkCloudHealth().then(() => {
            // 同时初始化 WASM
            initWASM(wasmPath, onReady);
        });
    } else {
        initWASM(wasmPath, onReady);
    }
}

/**
 * 搜索最佳方向 (自动选择引擎)
 * @param {number[]} cells - 16 格棋盘
 * @returns {number} 方向: 0上 1右 2下 3左, -1 无解
 */
async function search(cells) {
    if (!ready || !wasmExports) return -1;

    const engine = selectEngine(cells);

    // 云端搜索 (异步)
    if (engine === 'cloud') {
        return await cloudSearch(cells);
    }

    // WASM 搜索 (同步)
    const data = cellsToU64(cells);
    return Number(wasmExports.search(data));
}

/**
 * 同步版搜索 (WASM only)
 */
function searchSync(cells) {
    if (!ready || !wasmExports) return -1;
    const data = cellsToU64(cells);
    return Number(wasmExports.search(data));
}

/**
 * 应用一次移动
 */
function applyMove(cells, dir) {
    if (!ready || !wasmExports) return cells.slice();
    const data = cellsToU64(cells);
    const newData = wasmExports.applyMove(data, dir >>> 0);
    return u64ToCells(newData);
}

/**
 * 随机空格填一个 2 或 4
 */
function addRandomTile(cells, rngVal) {
    if (!ready || !wasmExports) return cells.slice();
    const data = cellsToU64(cells);
    const newData = wasmExports.addRandomTile(data, (rngVal >>> 0));
    return u64ToCells(newData);
}

/**
 * 返回空格数
 */
function countEmpty(cells) {
    if (!ready || !wasmExports) return 0;
    const data = cellsToU64(cells);
    return Number(wasmExports.countEmpty(data));
}

/**
 * 强制使用指定引擎
 */
function setEngine(engine) {
    forcedEngine = engine;
}

/**
 * 方向文字描述
 */
function dirName(dir) {
    if (dir === -1) return '无解';
    return DIR_NAME[dir & 3] || '?';
}

/**
 * 是否就绪
 */
function isReady() {
    return ready;
}

/**
 * 获取当前状态信息
 */
function status() {
    return {
        ready,
        engine: ready ? 'wasm' : null,
        cloudAvailable,
        cloudReady,
        forcedEngine,
    };
}

module.exports = {
    init,
    search,
    searchSync,
    applyMove,
    addRandomTile,
    countEmpty,
    has2048: detect2048,
    dirName,
    isReady,
    setEngine,
    status,
};
