#!/usr/bin/env node
/**
 * grokbot-wallpaper-win.mjs
 * Windows (and macOS compatible) local runtime wallpaper overlay & floating panel for Grok Bot.
 * Clean-room MIT implementation inspired by @KinGao476942 (grokbot-wallpaper).
 *
 * Security & Boundary Guarantees:
 * - Never modifies Grok Bot binaries, app.asar, installer files, or signatures.
 * - Binds local CDP & helper strictly to 127.0.0.1 (ports 19222 / 19223).
 * - Never uploads user images externally; stores active wallpaper copy only in local AppData.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
const BUNDLED_EXAMPLE_IMAGE = path.resolve(path.dirname(THIS_FILE), '..', 'examples', 'deepseek-whale-girl.png');
const CDP_PORT = 19222;
const HELPER_PORT = 19223;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const HELPER_BASE = `http://127.0.0.1:${HELPER_PORT}`;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const STATE_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'grokbot-wallpaper-win')
  : path.join(homedir(), 'Library', 'Application Support', 'grokbot-wallpaper-win');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SCRIPTS_FILE = path.join(STATE_DIR, 'injected-scripts.json');
const LOCAL_SCRIPT_COPY = path.join(STATE_DIR, 'grokbot-wallpaper-win.mjs');
const OPEN_PS1_FILE = path.join(STATE_DIR, 'open-grokbot.ps1');
const SHORTCUT_BACKUP_DIR = path.join(STATE_DIR, 'shortcut-backups');
const SHORTCUT_MANIFEST = path.join(SHORTCUT_BACKUP_DIR, 'manifest.json');

// Built-in default soft ocean-blue gradient SVG data URL when user runs `init` before choosing an image
const DEFAULT_PLACEHOLDER_SVG =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#dbeafe"/>
          <stop offset="50%" stop-color="#bfdbfe"/>
          <stop offset="100%" stop-color="#e0e7ff"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#bg)"/>
      <circle cx="1280" cy="240" r="280" fill="#93c5fd" fill-opacity="0.35"/>
      <circle cx="320" cy="780" r="340" fill="#a5b4fc" fill-opacity="0.3"/>
    </svg>`,
    'utf8'
  ).toString('base64');

const USAGE = `Grok Bot 换壁纸（Windows 适配版 · 支持 Windows 10/11 & macOS，需 Node.js 22+）

用法：
  node scripts/grokbot-wallpaper-win.mjs install [图片路径] [--opacity 0.88] [--dark|--light] [--relaunch]
  node scripts/grokbot-wallpaper-win.mjs init [--persist] [--relaunch]
  node scripts/grokbot-wallpaper-win.mjs apply [图片路径] [--opacity 0.88] [--dark|--light] [--persist] [--relaunch]
  node scripts/grokbot-wallpaper-win.mjs status
  node scripts/grokbot-wallpaper-win.mjs restore
  node scripts/grokbot-wallpaper-win.mjs uninstall
  node scripts/grokbot-wallpaper-win.mjs watch
  node scripts/grokbot-wallpaper-win.mjs snapshot <输出.png>

说明：
  - install 会默认换上内置的「蓝色大肥鱼」壁纸（也可传入自定义图片），挂出右下角「壁纸」小浮窗，并配置桌面/开始菜单图标自动挂载——以后每次点图标打开 Grok Bot 都自带壁纸与小浮窗。
  - init / apply 会在当前官方 Grok Bot 窗口右下角挂出「壁纸」小浮窗（加 --persist 可同步开启每次打开自动挂载）。
  - uninstall 一键移除当前壁纸、停止后台同步助手，并把桌面/开始菜单快捷方式完全恢复原状。
  - 首次开启本机调试端口需先保存工作并加 --relaunch 重启一次 Grok Bot；全程仅绑定 127.0.0.1:${CDP_PORT} / ${HELPER_PORT}，绝不修改 Grok Bot.exe、app.asar 或注册表。`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampOpacity(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error('透明度必须是 0.15 到 1 之间的数字。');
  return Math.max(0.15, Math.min(1, n));
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function findOfficialAppPath() {
  if (IS_WIN) {
    const candidates = [
      'C:\\Program Files\\Grok Bot\\Grok Bot.exe',
      path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Programs', 'Grok Bot', 'Grok Bot.exe'),
    ];
    for (const p of candidates) {
      if (await fileExists(p)) return p;
    }
    return null;
  }
  if (IS_MAC) {
    for (const p of ['/Applications/Grok Bot.app', path.join(homedir(), 'Applications', 'Grok Bot.app')]) {
      if (await fileExists(p)) return p;
    }
  }
  return null;
}

async function fetchJson(baseUrl, pathname, timeoutMs = 1800) {
  const res = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function probeCdp() {
  try {
    return await fetchJson(CDP_BASE, '/json/version', 1500);
  } catch {
    return null;
  }
}

async function probeHelper() {
  try {
    const data = await fetchJson(HELPER_BASE, '/health', 1200);
    return Boolean(data && data.ok);
  } catch {
    return false;
  }
}

async function isAppRunning(appExe) {
  if (await probeCdp()) return true;
  if (IS_WIN) {
    try {
      const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq Grok Bot.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
      return stdout.split(/\r?\n/).some((line) => /^"Grok Bot\.exe"/i.test(line.trim()));
    } catch {
      return false;
    }
  }
  if (IS_MAC && appExe) {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', 'application "Grok Bot" is running']);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }
  return false;
}

async function closeOfficialAppGracefully(appExe) {
  if (IS_WIN) {
    try {
      await execFileAsync('taskkill.exe', ['/IM', 'Grok Bot.exe'], { windowsHide: true, timeout: 6000 });
    } catch {}
    const softDeadline = Date.now() + 3500;
    while (Date.now() < softDeadline) {
      if (!(await isAppRunning(appExe))) return;
      await sleep(250);
    }
    // Tray-minimized Electron instances have MainWindowHandle=0 and ignore non-forced WM_CLOSE
    try {
      await execFileAsync('taskkill.exe', ['/IM', 'Grok Bot.exe', '/T', '/F'], { windowsHide: true, timeout: 6000 });
    } catch {}
    const hardDeadline = Date.now() + 5000;
    while (Date.now() < hardDeadline) {
      if (!(await isAppRunning(appExe))) return;
      await sleep(250);
    }
    throw new Error('未能退出后台运行中的 Grok Bot，请先在右下角系统托盘右键退出后再试。');
  }
  if (IS_MAC) {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "Grok Bot" to quit'], { timeout: 8000 });
    } catch {}
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!(await isAppRunning(appExe))) return;
      await sleep(300);
    }
    throw new Error('未能正常退出 Grok Bot，请手动退出后重试。');
  }
}

async function launchDetachedWin(filePath, args = [], hidden = false) {
  // Launch via PowerShell Start-Process outside temporary CLI job groups when possible
  const psFile = filePath.replace(/'/g, "''");
  const psArgs = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(', ');
  const argClause = args.length > 0 ? `-ArgumentList @(${psArgs})` : '';
  const styleClause = hidden ? '-WindowStyle Hidden' : '';
  const cmd = `Start-Process -FilePath '${psFile}' ${argClause} ${styleClause}`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd], {
      windowsHide: true,
      timeout: 8000,
    });
  } catch {
    const child = spawn(filePath, args, { detached: true, stdio: 'ignore', windowsHide: hidden });
    child.unref();
  }
}

async function relaunchWithDebugPort(appExe) {
  if (!appExe) throw new Error('未检测到官方 Grok Bot 安装路径，请确认已安装官方桌面客户端。');
  if (await isAppRunning(appExe)) {
    await closeOfficialAppGracefully(appExe);
  }
  if (IS_WIN) {
    const manifest = await readJsonSafe(SHORTCUT_MANIFEST, null);
    const preferredLnk = manifest?.activeShortcut && (await fileExists(manifest.activeShortcut)) ? manifest.activeShortcut : null;
    if (preferredLnk) {
      await execFileAsync('explorer.exe', [preferredLnk], { windowsHide: true }).catch(() => {});
    } else {
      await launchDetachedWin(appExe, [`--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1'], false);
    }
  } else {
    await execFileAsync('open', ['-a', appExe, '--args', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1']);
  }
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const ver = await probeCdp();
    if (ver) return ver;
    await sleep(400);
  }
  throw new Error('等待 Grok Bot 本机调试端口就绪超时（35 秒）。');
}

function filterRendererTargets(all) {
  return (all || []).filter((t) => {
    if (!['page', 'webview'].includes(t.type) || !t.webSocketDebuggerUrl) return false;
    if (/^(devtools|chrome|chrome-extension):/i.test(t.url || '')) return false;
    if (IS_WIN) {
      const u = (t.url || '').replace(/\\/g, '/').toLowerCase();
      return t.title === 'Grok Bot' || u.includes('/grok%20bot/resources/app.asar/') || u.includes('/grok bot/resources/app.asar/');
    }
    return true;
  });
}

async function tryListRendererTargets() {
  try {
    const all = await fetchJson(CDP_BASE, '/json/list', 1800);
    return filterRendererTargets(all);
  } catch {
    return [];
  }
}

async function listRendererTargets() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const all = await fetchJson(CDP_BASE, '/json/list', 2500);
      const filtered = filterRendererTargets(all);
      if (filtered.length > 0) return filtered;
    } catch {}
    await sleep(300);
  }
  throw new Error('未找到官方 Grok Bot 渲染窗口，请先打开主界面后重试。');
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const inflight = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 6000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      reject(ev.error || new Error('CDP WebSocket 连接失败'));
    }, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && inflight.has(msg.id)) {
      const { resolve, reject } = inflight.get(msg.id);
      inflight.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP 调用错误'));
      else resolve(msg.result);
    }
  });

  return {
    call(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => inflight.set(id, { resolve, reject }));
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

function detectMimeAndValidate(buf, ext) {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === '.png' && buf.subarray(0, 8).equals(pngMagic)) return 'image/png';
  if ((ext === '.jpg' || ext === '.jpeg') && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ext === '.webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('仅支持真实的 PNG / JPG / WEBP 图片文件，且文件头需与扩展名一致。');
}

async function prepareLocalImage(filePath) {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('指定的壁纸路径不是有效文件。');
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片大小为 ${(stat.size / 1024 / 1024).toFixed(2)}MB，超过 4MB 上限；请先压缩或换一张小于 4MB 的图片。`);
  }
  const ext = path.extname(resolved).toLowerCase();
  const buf = await fs.readFile(resolved);
  const mime = detectMimeAndValidate(buf, ext);
  const normExt = ext === '.jpeg' ? '.jpg' : ext;
  await fs.mkdir(STATE_DIR, { recursive: true });
  const savedCopy = path.join(STATE_DIR, `current${normExt}`);
  await fs.writeFile(`${savedCopy}.tmp`, buf);
  await fs.rename(`${savedCopy}.tmp`, savedCopy);
  return {
    imagePath: savedCopy,
    sourcePath: resolved,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
  };
}

async function saveFromDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('图片数据格式不受支持（仅支持 PNG/JPG/WEBP）。');
  const buf = Buffer.from(m[2], 'base64');
  const ext = m[1] === 'png' ? '.png' : m[1] === 'webp' ? '.webp' : '.jpg';
  detectMimeAndValidate(buf, ext);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 4MB 上限。');
  await fs.mkdir(STATE_DIR, { recursive: true });
  const savedCopy = path.join(STATE_DIR, `current${ext}`);
  await fs.writeFile(`${savedCopy}.tmp`, buf);
  await fs.rename(`${savedCopy}.tmp`, savedCopy);
  return { imagePath: savedCopy, dataUrl };
}

/**
 * Browser-side runtime overlay function serialized into Grok Bot renderer.
 */
function browserOverlayRuntime(cfg) {
  const GLOBAL_KEY = '__grokbotWallpaperWinOverlay';
  if (window[GLOBAL_KEY] && typeof window[GLOBAL_KEY].update === 'function') {
    return window[GLOBAL_KEY].update(cfg);
  }

  const state = {
    dataUrl: cfg.dataUrl,
    opacity: Math.max(0.15, Math.min(1, Number(cfg.opacity ?? 0.88))),
    appearance: cfg.appearance === 'light' ? 'light' : 'dark',
    helperUrl: cfg.helperUrl || '',
  };

  const modifiedNodes = new Map();
  let pendingSync = null;
  let stopped = false;
  let observer = null;
  let scanTimer = null;

  const styleEl = document.createElement('style');
  styleEl.id = 'gb-wp-win-style';
  styleEl.textContent = `
    #gb-wp-win-layer {
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background-position: center center; background-size: cover; background-repeat: no-repeat;
      transition: opacity 140ms ease;
    }
    #gb-wp-win-panel {
      position: fixed; right: 18px; bottom: 76px; z-index: 2147483646;
      width: 248px; border-radius: 16px; padding: 14px 16px;
      background: rgba(24, 27, 34, 0.88); color: #f8fafc;
      backdrop-filter: blur(14px); box-shadow: 0 12px 32px rgba(0,0,0,0.32);
      font: 13px/1.45 -apple-system, "Microsoft YaHei", sans-serif;
      user-select: none;
    }
    #gb-wp-win-panel.collapsed .gb-wp-body { display: none; }
    #gb-wp-win-panel .gb-wp-fab { display: none; }
    #gb-wp-win-panel.collapsed {
      width: auto; padding: 0; background: transparent; box-shadow: none; backdrop-filter: none;
    }
    #gb-wp-win-panel.collapsed .gb-wp-fab {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18);
      background: rgba(24, 27, 34, 0.86); color: #fff; cursor: pointer;
      font-weight: 600; box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    }
    .gb-wp-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; cursor: move; }
    .gb-wp-title { font-weight: 700; font-size: 14px; }
    .gb-wp-collapse {
      border: 0; border-radius: 8px; padding: 4px 10px;
      background: rgba(255,255,255,0.14); color: #fff; cursor: pointer; font-size: 12px;
    }
    .gb-wp-upload {
      display: block; width: 100%; text-align: center; padding: 9px 0; margin-bottom: 12px;
      border-radius: 10px; background: rgba(255,255,255,0.14); color: #fff;
      cursor: pointer; font-weight: 600; transition: background 120ms;
    }
    .gb-wp-upload:hover { background: rgba(255,255,255,0.22); }
    .gb-wp-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; color: #e2e8f0; }
    .gb-wp-slider { width: 100%; accent-color: #60a5fa; cursor: pointer; }
    .gb-wp-note { margin-top: 6px; font-size: 11px; color: #93c5fd; min-height: 15px; }
  `;

  const layerEl = document.createElement('div');
  layerEl.id = 'gb-wp-win-layer';

  const panelEl = document.createElement('div');
  panelEl.id = 'gb-wp-win-panel';

  const fabBtn = document.createElement('button');
  fabBtn.type = 'button';
  fabBtn.className = 'gb-wp-fab';
  fabBtn.textContent = '壁纸';
  fabBtn.addEventListener('click', () => panelEl.classList.remove('collapsed'));

  const bodyEl = document.createElement('div');
  bodyEl.className = 'gb-wp-body';

  const headerEl = document.createElement('div');
  headerEl.className = 'gb-wp-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'gb-wp-title';
  titleEl.textContent = '壁纸';
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'gb-wp-collapse';
  collapseBtn.textContent = '收起';
  collapseBtn.addEventListener('click', () => panelEl.classList.add('collapsed'));
  headerEl.append(titleEl, collapseBtn);

  const uploadLabel = document.createElement('label');
  uploadLabel.className = 'gb-wp-upload';
  uploadLabel.textContent = '上传壁纸';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.style.display = 'none';
  uploadLabel.append(fileInput);

  const rowEl = document.createElement('div');
  rowEl.className = 'gb-wp-row';
  const rowText = document.createElement('span');
  rowText.textContent = '透明度';
  const rowVal = document.createElement('span');
  rowEl.append(rowText, rowVal);

  const sliderEl = document.createElement('input');
  sliderEl.type = 'range';
  sliderEl.className = 'gb-wp-slider';
  sliderEl.min = '0.15';
  sliderEl.max = '1';
  sliderEl.step = '0.01';
  sliderEl.value = String(state.opacity);

  const noteEl = document.createElement('div');
  noteEl.className = 'gb-wp-note';

  bodyEl.append(headerEl, uploadLabel, rowEl, sliderEl, noteEl);
  panelEl.append(fabBtn, bodyEl);

  // Draggable header
  let dragOffset = null;
  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target === collapseBtn) return;
    const rect = panelEl.getBoundingClientRect();
    dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    headerEl.setPointerCapture(e.pointerId);
  });
  headerEl.addEventListener('pointermove', (e) => {
    if (!dragOffset) return;
    const left = Math.max(8, Math.min(window.innerWidth - panelEl.offsetWidth - 8, e.clientX - dragOffset.dx));
    const top = Math.max(8, Math.min(window.innerHeight - panelEl.offsetHeight - 8, e.clientY - dragOffset.dy));
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
  });
  headerEl.addEventListener('pointerup', () => { dragOffset = null; });

  function renderLayer() {
    rowVal.textContent = state.opacity.toFixed(2);
    const veil = state.appearance === 'light'
      ? 'linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0.18))'
      : 'linear-gradient(rgba(16,19,25,0.12), rgba(16,19,25,0.12))';
    layerEl.style.backgroundImage = `${veil}, url("${state.dataUrl}")`;
    layerEl.style.opacity = String(state.opacity);
  }

  async function syncToLocalHelper(payload) {
    pendingSync = payload;
    if (!state.helperUrl) return;
    try {
      await fetch(`${state.helperUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {}
  }

  sliderEl.addEventListener('input', () => {
    state.opacity = Math.max(0.15, Math.min(1, Number(sliderEl.value)));
    renderLayer();
    noteEl.textContent = '透明度已更新';
    void syncToLocalHelper({ opacity: state.opacity, appearance: state.appearance });
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      noteEl.textContent = '图片超过 4MB，请换小一点的图';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(result)) {
        noteEl.textContent = '仅支持 PNG / JPG / WEBP';
        return;
      }
      state.dataUrl = result;
      renderLayer();
      noteEl.textContent = '新壁纸已换上！';
      void syncToLocalHelper({ dataUrl: state.dataUrl, opacity: state.opacity, appearance: state.appearance });
    };
    reader.readAsDataURL(file);
  });

  function rememberAndSetStyle(el, prop, val) {
    if (!modifiedNodes.has(el)) modifiedNodes.set(el, new Map());
    const map = modifiedNodes.get(el);
    if (!map.has(prop)) {
      map.set(prop, { val: el.style.getPropertyValue(prop), pri: el.style.getPropertyPriority(prop) });
    }
    el.style.setProperty(prop, val, 'important');
  }

  function shouldIgnore(el) {
    return (
      el === layerEl ||
      el === styleEl ||
      el === panelEl ||
      panelEl.contains(el) ||
      Boolean(el.closest('button,input,textarea,select,dialog,[role="dialog"],[role="menu"],[role="listbox"],[contenteditable="true"]'))
    );
  }

  function makeContainersTranslucent() {
    if (stopped || !document.body) return;
    observer?.disconnect();
    rememberAndSetStyle(document.documentElement, 'background-color', 'transparent');
    rememberAndSetStyle(document.body, 'background-color', 'transparent');
    rememberAndSetStyle(document.body, 'isolation', 'isolate');

    const viewportArea = window.innerWidth * window.innerHeight;
    for (const el of document.body.querySelectorAll('*')) {
      if (shouldIgnore(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.22 || r.height < window.innerHeight * 0.45 || r.width * r.height < viewportArea * 0.16) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible' || Number(cs.opacity) < 0.85 || cs.backgroundImage !== 'none') continue;
      if (modifiedNodes.get(el)?.has('background-color')) continue;
      const m = cs.backgroundColor.match(/^rgba?\(([^)]+)\)$/);
      if (!m) continue;
      const nums = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if ((nums[3] ?? 1) < 0.85) continue;
      rememberAndSetStyle(el, 'background-color', `color-mix(in srgb, ${cs.backgroundColor} 28%, transparent)`);
    }
    observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  function scheduleScan() {
    if (!scanTimer) {
      scanTimer = setTimeout(() => {
        scanTimer = null;
        makeContainersTranslucent();
      }, 180);
    }
  }

  function mount() {
    if (stopped) return;
    renderLayer();
    document.head.append(styleEl);
    document.body.prepend(layerEl);
    document.body.append(panelEl);
    observer = new MutationObserver(scheduleScan);
    makeContainersTranslucent();
    window.addEventListener('resize', scheduleScan);
  }

  window[GLOBAL_KEY] = {
    update(next = {}) {
      if (next.dataUrl) state.dataUrl = next.dataUrl;
      if (Number.isFinite(Number(next.opacity))) {
        state.opacity = Math.max(0.15, Math.min(1, Number(next.opacity)));
        sliderEl.value = String(state.opacity);
      }
      if (next.appearance === 'light' || next.appearance === 'dark') state.appearance = next.appearance;
      renderLayer();
      makeContainersTranslucent();
      return { ok: true, opacity: state.opacity };
    },
    takePending() {
      const out = pendingSync;
      pendingSync = null;
      return out;
    },
    restore() {
      stopped = true;
      observer?.disconnect();
      clearTimeout(scanTimer);
      window.removeEventListener('resize', scheduleScan);
      layerEl.remove();
      styleEl.remove();
      panelEl.remove();
      for (const [el, props] of modifiedNodes) {
        for (const [prop, prev] of props) {
          if (prev.val) el.style.setProperty(prop, prev.val, prev.pri);
          else el.style.removeProperty(prop);
        }
      }
      modifiedNodes.clear();
      delete window[GLOBAL_KEY];
      return { ok: true };
    },
  };

  if (document.body && document.head) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  return { ok: true, opacity: state.opacity };
}

async function injectOverlayToWindow(config) {
  const targets = await listRendererTargets();
  const prevScripts = (await readJsonSafe(SCRIPTS_FILE, {})) || {};
  const nextScripts = {};
  const expr = `(${browserOverlayRuntime.toString()})(${JSON.stringify(config)});`;

  for (const t of targets) {
    const cdp = await connectCdp(t.webSocketDebuggerUrl);
    try {
      await cdp.call('Page.enable');
      await cdp.call('Runtime.enable');
      if (prevScripts[t.id]) {
        try {
          await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: prevScripts[t.id] });
        } catch {}
      }
      const added = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: expr });
      if (added && added.identifier) nextScripts[t.id] = added.identifier;
      await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true });
    } finally {
      cdp.close();
    }
  }
  await writeJsonAtomic(SCRIPTS_FILE, nextScripts);
}

async function restoreWindow() {
  const targets = await listRendererTargets();
  const prevScripts = (await readJsonSafe(SCRIPTS_FILE, {})) || {};
  for (const t of targets) {
    const cdp = await connectCdp(t.webSocketDebuggerUrl);
    try {
      await cdp.call('Page.enable');
      if (prevScripts[t.id]) {
        try {
          await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: prevScripts[t.id] });
        } catch {}
      }
      // Also clean up upstream key if present
      await cdp.call('Runtime.evaluate', {
        expression: `
          if (window.__grokbotWallpaperWinOverlay) window.__grokbotWallpaperWinOverlay.restore();
          if (window.__grokbotWallpaperOverlay) window.__grokbotWallpaperOverlay.restore();
        `,
        returnByValue: true,
      });
    } finally {
      cdp.close();
    }
  }
  await writeJsonAtomic(SCRIPTS_FILE, {});
  const prev = (await readJsonSafe(STATE_FILE, {})) || {};
  await writeJsonAtomic(STATE_FILE, { ...prev, restored: true, restoredAt: new Date().toISOString() });
}

async function captureWindowPng(outPath) {
  const targets = await listRendererTargets();
  const cdp = await connectCdp(targets[0].webSocketDebuggerUrl);
  try {
    await cdp.call('Page.enable');
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(shot.data, 'base64');
    const dest = path.resolve(outPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(`${dest}.tmp`, buf);
    await fs.rename(`${dest}.tmp`, dest);
    return { file: dest, bytes: buf.length };
  } finally {
    cdp.close();
  }
}

async function startLocalSyncServer() {
  if (await probeHelper()) return true;
  const server = http.createServer(async (req, res) => {
    const addr = req.socket.remoteAddress;
    const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (!isLocal) {
      res.writeHead(403, headers);
      res.end(JSON.stringify({ ok: false, error: 'loopback only' }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 80);
      return;
    }
    if (req.method === 'POST' && req.url === '/sync') {
      try {
        const chunks = [];
        let len = 0;
        for await (const c of req) {
          len += c.length;
          if (len > 8 * 1024 * 1024) throw new Error('payload too large');
          chunks.push(c);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const prev = (await readJsonSafe(STATE_FILE, {})) || {};
        const opacity = body.opacity != null ? clampOpacity(body.opacity) : clampOpacity(prev.opacity ?? 0.88);
        const appearance = body.appearance === 'light' ? 'light' : 'dark';
        let imagePath = prev.imagePath || null;
        let dataUrl = null;
        if (body.dataUrl) {
          const saved = await saveFromDataUrl(body.dataUrl);
          imagePath = saved.imagePath;
          dataUrl = saved.dataUrl;
        } else if (imagePath) {
          const loaded = await prepareLocalImage(imagePath);
          dataUrl = loaded.dataUrl;
        }
        if (dataUrl && (await probeCdp())) {
          await injectOverlayToWindow({ dataUrl, opacity, appearance, helperUrl: HELPER_BASE });
        }
        await writeJsonAtomic(STATE_FILE, {
          imagePath,
          opacity,
          appearance,
          updatedAt: new Date().toISOString(),
          restored: false,
        });
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, opacity, imagePath }));
      } catch (err) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ ok: false }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HELPER_PORT, '127.0.0.1', () => resolve());
  });
  return true;
}

async function stopWatchDaemon() {
  try {
    await fetch(`${HELPER_BASE}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1200) });
    await sleep(250);
  } catch {}
}

async function ensureBackgroundWatchDaemon() {
  if (await probeHelper()) return true;
  await fs.mkdir(STATE_DIR, { recursive: true });
  const watchScript = (await fileExists(LOCAL_SCRIPT_COPY)) ? LOCAL_SCRIPT_COPY : path.resolve(THIS_FILE);
  if (IS_WIN) {
    await launchDetachedWin(process.execPath, [watchScript, 'watch'], true);
  } else {
    const child = spawn(process.execPath, [watchScript, 'watch'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await probeHelper()) return true;
    await sleep(150);
  }
  return false;
}

async function runWatchLoop() {
  try {
    await startLocalSyncServer();
  } catch {
    return;
  }
  const injectedTargetIds = new Set();
  for (;;) {
    try {
      const targets = await tryListRendererTargets();
      const currentIds = new Set(targets.map((t) => t.id));
      for (const id of [...injectedTargetIds]) {
        if (!currentIds.has(id)) injectedTargetIds.delete(id);
      }

      const hasNewTarget = targets.some((t) => !injectedTargetIds.has(t.id));
      if (hasNewTarget) {
        const saved = await readJsonSafe(STATE_FILE, null);
        if (saved && !saved.restored) {
          await sleep(500);
          let dataUrl = DEFAULT_PLACEHOLDER_SVG;
          if (saved.imagePath && (await fileExists(saved.imagePath))) {
            const img = await prepareLocalImage(saved.imagePath);
            dataUrl = img.dataUrl;
          }
          await injectOverlayToWindow({
            dataUrl,
            opacity: clampOpacity(saved.opacity ?? 0.88),
            appearance: saved.appearance === 'light' ? 'light' : 'dark',
            helperUrl: HELPER_BASE,
          });
          const refreshed = await tryListRendererTargets();
          for (const t of refreshed) injectedTargetIds.add(t.id);
        }
      }
    } catch {}
    await sleep(1200);
  }
}

async function enableAutoOpenPersistence(appExe) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  if (path.resolve(THIS_FILE) !== path.resolve(LOCAL_SCRIPT_COPY)) {
    await fs.copyFile(THIS_FILE, LOCAL_SCRIPT_COPY);
  }
  if (!IS_WIN) {
    return { enabled: false, note: 'macOS 当前保持手动/会话模式' };
  }

  const psLauncher = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$appExe = '${appExe.replace(/'/g, "''")}'`,
    `$nodeExe = '${process.execPath.replace(/'/g, "''")}'`,
    `$scriptPath = '${LOCAL_SCRIPT_COPY.replace(/'/g, "''")}'`,
    "$c = New-Object System.Net.Sockets.TcpClient",
    `$ready = $c.ConnectAsync('127.0.0.1', ${CDP_PORT}).Wait(150)`,
    "$c.Dispose()",
    "if (-not $ready) {",
    "  $procs = @(Get-Process -Name 'Grok Bot' -ErrorAction SilentlyContinue)",
    "  if ($procs.Count -gt 0 -and @($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count -eq 0) {",
    "    Stop-Process -Name 'Grok Bot' -Force -ErrorAction SilentlyContinue",
    "    Start-Sleep -Milliseconds 400",
    "  }",
    "}",
    `Start-Process -FilePath $appExe -ArgumentList '--remote-debugging-port=${CDP_PORT}','--remote-debugging-address=127.0.0.1' -WorkingDirectory (Split-Path $appExe)`,
    "Start-Process -FilePath $nodeExe -ArgumentList ('\"' + $scriptPath + '\"'), 'watch' -WindowStyle Hidden",
  ].join('\r\n');
  await fs.writeFile(OPEN_PS1_FILE, psLauncher, 'utf8');

  await fs.mkdir(SHORTCUT_BACKUP_DIR, { recursive: true });
  const prevManifest = (await readJsonSafe(SHORTCUT_MANIFEST, null)) || { entries: [] };

  const psUpdate = `
$ErrorActionPreference = 'Stop'
$appExe = '${appExe.replace(/'/g, "''")}'
$ps1 = '${OPEN_PS1_FILE.replace(/'/g, "''")}'
$backupDir = '${SHORTCUT_BACKUP_DIR.replace(/'/g, "''")}'
$wsh = New-Object -ComObject WScript.Shell

$candidates = @(
  @{ Key = 'userDesktop'; Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grok Bot.lnk') },
  @{ Key = 'publicDesktop'; Path = (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Grok Bot.lnk') },
  @{ Key = 'userStartMenu'; Path = (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\\Grok Bot.lnk') },
  @{ Key = 'commonStartMenu'; Path = (Join-Path ([Environment]::GetFolderPath('CommonStartMenu')) 'Programs\\Grok Bot.lnk') }
)

$updated = @()
$desktopUpdated = $false
foreach ($item in $candidates) {
  if (Test-Path $item.Path) {
    $bak = Join-Path $backupDir ($item.Key + '.lnk.bak')
    if (-not (Test-Path $bak)) {
      Copy-Item -Path $item.Path -Destination $bak -Force
    }
    try {
      $sc = $wsh.CreateShortcut($item.Path)
      $sc.TargetPath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      $sc.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ps1 + '"'
      $sc.WorkingDirectory = (Split-Path $appExe)
      $sc.IconLocation = $appExe + ',0'
      $sc.WindowStyle = 7
      $sc.Save()
      $updated += @{ key = $item.Key; path = $item.Path; backup = $bak; created = $false }
      if ($item.Key -like '*Desktop') { $desktopUpdated = $true }
    } catch {}
  }
}

if (-not $desktopUpdated) {
  $userDeskLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grok Bot.lnk'
  $sc = $wsh.CreateShortcut($userDeskLnk)
  $sc.TargetPath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  $sc.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ps1 + '"'
  $sc.WorkingDirectory = (Split-Path $appExe)
  $sc.IconLocation = $appExe + ',0'
  $sc.WindowStyle = 7
  $sc.Save()
  $updated += @{ key = 'userDesktopCreated'; path = $userDeskLnk; backup = ''; created = $true }
}

$updated | ConvertTo-Json -Compress
`;

  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psUpdate], {
    windowsHide: true,
    timeout: 12000,
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const merged = prevManifest.entries?.length ? prevManifest.entries : entries;
  const activeShortcut = entries.find((e) => e.path)?.path || null;
  await writeJsonAtomic(SHORTCUT_MANIFEST, {
    enabled: true,
    appExe,
    activeShortcut,
    entries: merged,
    updatedAt: new Date().toISOString(),
  });
  return { enabled: true, shortcutsUpdated: entries.map((e) => e.path) };
}

async function disableAutoOpenPersistence(appExe) {
  if (!IS_WIN) return { disabled: true };
  const manifest = await readJsonSafe(SHORTCUT_MANIFEST, null);
  if (manifest && Array.isArray(manifest.entries)) {
    const psRestore = `
$ErrorActionPreference = 'SilentlyContinue'
$appExe = '${(appExe || manifest.appExe || 'C:\\Program Files\\Grok Bot\\Grok Bot.exe').replace(/'/g, "''")}'
$entries = '${JSON.stringify(manifest.entries).replace(/'/g, "''")}' | ConvertFrom-Json
$wsh = New-Object -ComObject WScript.Shell
foreach ($e in $entries) {
  if ($e.created -and (Test-Path $e.path)) {
    Remove-Item -Path $e.path -Force
  } elseif ($e.backup -and (Test-Path $e.backup)) {
    Copy-Item -Path $e.backup -Destination $e.path -Force
  } elseif (Test-Path $e.path) {
    $sc = $wsh.CreateShortcut($e.path)
    $sc.TargetPath = $appExe
    $sc.Arguments = ''
    $sc.WorkingDirectory = (Split-Path $appExe)
    $sc.IconLocation = $appExe + ',0'
    $sc.WindowStyle = 1
    $sc.Save()
  }
}
`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psRestore], {
      windowsHide: true,
      timeout: 12000,
    }).catch(() => {});
  }
  await fs.rm(OPEN_PS1_FILE, { force: true }).catch(() => {});
  await writeJsonAtomic(SHORTCUT_MANIFEST, { enabled: false, entries: [], updatedAt: new Date().toISOString() });
  return { disabled: true };
}

async function isAutoOpenEnabled() {
  if (!IS_WIN) return false;
  const m = await readJsonSafe(SHORTCUT_MANIFEST, null);
  return Boolean(m && m.enabled && (await fileExists(OPEN_PS1_FILE)));
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('需要 Node.js 22 或更高版本（内置 WebSocket 支持）。');
  }
  if (!IS_WIN && !IS_MAC) {
    throw new Error('当前仅支持 Windows 10/11 与 macOS。');
  }

  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'status') {
    const appExe = await findOfficialAppPath();
    const cdp = await probeCdp();
    const helper = await probeHelper();
    const running = await isAppRunning(appExe);
    const autoOpen = await isAutoOpenEnabled();
    const last = await readJsonSafe(STATE_FILE, null);
    console.log(
      JSON.stringify(
        {
          platform: process.platform,
          appPath: appExe,
          running,
          debugPortReady: Boolean(cdp),
          panelHelperRunning: helper,
          autoOpenEnabled: autoOpen,
          port: CDP_PORT,
          helperPort: HELPER_PORT,
          state: last,
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'watch') {
    await runWatchLoop();
    return;
  }

  if (cmd === 'restore') {
    if (await probeCdp()) {
      await restoreWindow();
    } else {
      const prev = (await readJsonSafe(STATE_FILE, {})) || {};
      await writeJsonAtomic(STATE_FILE, { ...prev, restored: true, restoredAt: new Date().toISOString() });
    }
    console.log('已恢复 Grok Bot 默认界面并移除壁纸悬浮面板。');
    return;
  }

  if (cmd === 'uninstall') {
    const appExe = await findOfficialAppPath();
    if (await probeCdp()) {
      await restoreWindow().catch(() => {});
    } else {
      const prev = (await readJsonSafe(STATE_FILE, {})) || {};
      await writeJsonAtomic(STATE_FILE, { ...prev, restored: true, restoredAt: new Date().toISOString() });
    }
    await stopWatchDaemon();
    await disableAutoOpenPersistence(appExe);
    console.log('已卸载自动挂载配置、恢复桌面/开始菜单原版快捷方式，并还原 Grok Bot 默认黑白界面。');
    return;
  }

  if (cmd === 'snapshot') {
    const out = rest[0];
    if (!out) throw new Error('请指定截图保存路径，例如：snapshot ./preview.png');
    if (!(await probeCdp())) throw new Error('本机调试端口未开启，无法截图。');
    const res = await captureWindowPng(out);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    return;
  }

  if (cmd === 'install' || cmd === 'init' || cmd === 'apply') {
    let imageArg = null;
    let opacity = 0.88;
    let appearance = 'dark';
    let allowRelaunch = false;
    let persistShortcut = cmd === 'install';

    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--relaunch') allowRelaunch = true;
      else if (a === '--persist' || a === '--autostart') persistShortcut = true;
      else if (a === '--no-persist') persistShortcut = false;
      else if (a === '--dark') appearance = 'dark';
      else if (a === '--light') appearance = 'light';
      else if (a === '--opacity') opacity = clampOpacity(rest[++i]);
      else if (a.startsWith('--opacity=')) opacity = clampOpacity(a.split('=')[1]);
      else if (!a.startsWith('--') && !imageArg) imageArg = a;
      else throw new Error(`未知参数：${a}`);
    }

    const appExe = await findOfficialAppPath();
    if (!appExe) throw new Error('未检测到官方 Grok Bot 安装路径，请确认已安装官方桌面客户端。');

    let dataUrl = DEFAULT_PLACEHOLDER_SVG;
    let imagePath = null;
    let sourcePath = null;

    if (imageArg) {
      const prep = await prepareLocalImage(imageArg);
      dataUrl = prep.dataUrl;
      imagePath = prep.imagePath;
      sourcePath = prep.sourcePath;
    } else {
      const prev = await readJsonSafe(STATE_FILE, null);
      if (prev && prev.imagePath && !prev.restored && (await fileExists(prev.imagePath))) {
        const prep = await prepareLocalImage(prev.imagePath);
        dataUrl = prep.dataUrl;
        imagePath = prep.imagePath;
        sourcePath = prev.sourcePath || prep.sourcePath;
      } else if (cmd !== 'init' && (await fileExists(BUNDLED_EXAMPLE_IMAGE))) {
        const prep = await prepareLocalImage(BUNDLED_EXAMPLE_IMAGE);
        dataUrl = prep.dataUrl;
        imagePath = prep.imagePath;
        sourcePath = prep.sourcePath;
      }
    }

    await writeJsonAtomic(STATE_FILE, {
      imagePath,
      sourcePath,
      opacity,
      appearance,
      updatedAt: new Date().toISOString(),
      restored: false,
    });

    let persistResult = null;
    if (persistShortcut) {
      persistResult = await enableAutoOpenPersistence(appExe);
    }

    let cdp = await probeCdp();
    if (!cdp) {
      if (!allowRelaunch) {
        console.error('首次启用壁纸面板需要重启一次 Grok Bot（仅在 127.0.0.1 开启本机调试口）。请先保存当前聊天工作，确认后加 --relaunch 参数重新执行。');
        process.exitCode = 2;
        return;
      }
      cdp = await relaunchWithDebugPort(appExe);
    }

    const helperOk = await ensureBackgroundWatchDaemon();
    await injectOverlayToWindow({ dataUrl, opacity, appearance, helperUrl: HELPER_BASE });

    console.log(
      `已在 Grok Bot 窗口挂载壁纸与右下角「壁纸」小浮窗（透明度 ${opacity}，后台同步助手：${helperOk ? '运行中' : '未启动'}）。\n` +
      (persistResult?.enabled
        ? `已开启「打开即生效」：以后双击桌面或开始菜单的 Grok Bot 图标打开，都会自动带上壁纸和小浮窗！\n`
        : '') +
      `随时可点击右下角「壁纸 → 上传壁纸」换自己喜欢的图（4MB 以内 PNG/JPG/WEBP），或运行 uninstall 一键恢复原状。`
    );
    return;
  }

  throw new Error(`未知命令：${cmd}。运行 --help 查看帮助。`);
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exitCode = 1;
});
