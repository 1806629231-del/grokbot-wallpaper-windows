---
name: Grok Bot 换壁纸（Windows 适配版）
description: 当用户在 Windows（或 macOS）上希望给官方 Grok Bot 桌面客户端更换自定义背景壁纸、唤起右下角壁纸悬浮面板、调整壁纸透明度或恢复默认外观时使用。
---

# Grok Bot 换壁纸（Windows 适配版）

官方 Grok Bot 桌面端没有内置自定义背景图开关。本技能通过仅绑定本机回环地址（`127.0.0.1`）的调试连接，在当前窗口挂载可随时还原的临时背景层与右下角「壁纸」悬浮控制面板。

## 安全硬规则

1. **严禁修改官方程序**：不得修改 `Grok Bot.exe`、`Grok Bot.app`、`app.asar`、安装目录文件或注册表开机自启项。
2. **严禁外发用户图片**：不得上传用户壁纸到任何外部图床或服务器；仅在本机 `%LOCALAPPDATA%\grokbot-wallpaper-win\`（macOS 为 `~/Library/Application Support/grokbot-wallpaper-win/`）保存当前壁纸副本。
3. **仅限本机回环端口**：调试端口固定 `127.0.0.1:19222`，本地面板同步服务固定 `127.0.0.1:19223`。严禁绑定 `0.0.0.0` 或做局域网/公网端口转发。
4. **重启前必须经用户同意**：首次开启调试连接需要重启 Grok Bot 窗口。未经用户明确同意，不得带 `--relaunch` 关闭正在运行的窗口。
5. **只操作官方客户端**：认准官方安装路径（`C:\Program Files\Grok Bot\Grok Bot.exe` 或 `%LOCALAPPDATA%\Programs\Grok Bot\Grok Bot.exe`），不要触碰其他同名第三方程序。

## Agent 执行步骤

1. **检查环境**（要求本机安装 Node.js 22+）：
   ```powershell
   node scripts/grokbot-wallpaper-win.mjs status
   ```
2. **唤起壁纸面板或应用指定图片**：
   - 若用户只想先把右下角「壁纸 → 上传壁纸」面板挂出来自己挑图：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs init
     ```
   - 若用户已提供本地图片路径（或想先试内置的蓝色大肥鱼示例图 `examples/deepseek-whale-girl.png`）：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs apply "<图片路径>" --opacity 0.88 --dark
     ```
     *支持 PNG / JPG / WEBP，单张大小不超过 4MB；`--opacity` 范围 `0.15`–`1`（推荐 `0.88`）。*
3. **处理首次重启确认（退出码为 2 时）**：
   - 如果 `debugPortReady` 为 `false` 且命令返回退出码 `2`，先向用户说明：
     > “第一次挂载壁纸面板需要重开一次 Grok Bot 窗口（仅在本机 127.0.0.1 开启连接），请先确认当前对话已保存，回复同意后我帮你重开并挂上壁纸。”
   - 用户确认后，加上 `--relaunch` 执行：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs apply "<图片路径>" --opacity 0.88 --dark --relaunch
     ```
     （若 Grok Bot 最小化在系统托盘未退出，提示用户在右下角托盘右键退出一次即可。）
4. **告知用户如何使用悬浮面板**：
   - 挂载成功后告诉用户：窗口右下角已出现 **「壁纸」** 面板，随时可以点 **「上传壁纸」挑一张自己喜欢的图**，或拉动滑条实时调整透明度；彻底关闭客户端后临时背景会自动失效。
5. **恢复默认黑白界面**：
   - 当用户要求取消或还原壁纸时执行：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs restore
     ```
