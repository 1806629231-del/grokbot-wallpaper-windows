---
name: Grok Bot 换壁纸（Windows 适配版）
description: 当用户在 Windows（或 macOS）上希望给官方 Grok Bot 桌面客户端更换自定义背景壁纸、开启每次打开自动生效、唤起右下角壁纸悬浮面板、调整壁纸透明度或一键卸载还原默认外观时使用。
---

# Grok Bot 换壁纸（Windows 适配版）

官方 Grok Bot 桌面端没有内置自定义背景图开关。本技能通过仅绑定本机回环地址（`127.0.0.1`）的调试连接与桌面/开始菜单快捷方式无损包装，为官方窗口挂载可随时还原的自定义壁纸与右下角「壁纸」小浮窗，并支持每次点击图标打开时自动挂载生效。

## 安全硬规则

1. **严禁修改官方程序与注册表**：不得修改 `Grok Bot.exe`、`Grok Bot.app`、`app.asar`、安装目录文件或系统注册表开机自启项（`HKCU/HKLM Run`）。自动挂载仅通过备份并更新桌面/开始菜单 `Grok Bot.lnk` 快捷方式实现，且 `uninstall` 必须能完整还原备份。
2. **严禁外发用户图片**：不得上传用户壁纸到任何外部图床或服务器；仅在本机 `%LOCALAPPDATA%\grokbot-wallpaper-win\`（macOS 为 `~/Library/Application Support/grokbot-wallpaper-win/`）保存当前壁纸副本与脚本副本。
3. **仅限本机回环端口**：调试端口固定 `127.0.0.1:19222`，本地面板同步服务固定 `127.0.0.1:19223`。严禁绑定 `0.0.0.0` 或做局域网/公网端口转发。
4. **重启前必须经用户同意**：若当前运行的 Grok Bot 未开启本机调试端口，首次挂载需要重启 Grok Bot 窗口。未经用户明确同意，不得带 `--relaunch` 关闭正在运行的窗口。
5. **只操作官方客户端**：认准官方安装路径（`C:\Program Files\Grok Bot\Grok Bot.exe` 或 `%LOCALAPPDATA%\Programs\Grok Bot\Grok Bot.exe`），不要触碰其他同名第三方程序。

## Agent 执行步骤

1. **检查环境**（要求本机安装 Node.js 22+）：
   ```powershell
   node scripts/grokbot-wallpaper-win.mjs status
   ```
2. **一键安装并启用每次打开自动挂载（推荐默认动作）**：
   - 若用户希望装好后开箱即带壁纸（默认使用内置 `examples/deepseek-whale-girl.png`，也可传入用户指定的本地图片路径），且以后每次点桌面/开始菜单图标打开都自动生效：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs install
     ```
   - 若用户只想在当前会话临时体验、不改快捷方式：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs apply "<图片路径>" --opacity 0.88 --dark
     ```
     *支持 PNG / JPG / WEBP，单张大小不超过 4MB；`--opacity` 范围 `0.15`–`1`（推荐 `0.88`）。*
3. **处理首次重启确认（退出码为 2 时）**：
   - 如果 `debugPortReady` 为 `false` 且命令返回退出码 `2`，先向用户说明：
     > “第一次挂载壁纸面板需要重开一次 Grok Bot 窗口（仅在本机 127.0.0.1 开启连接），请先确认当前对话已保存，回复同意后我帮你重开并挂上壁纸。”
   - 用户确认后，加上 `--relaunch` 执行：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs install --relaunch
     ```
4. **告知用户如何使用小浮窗与自动挂载**：
   - 挂载成功后告诉用户：
     1. 窗口已换上壁纸，右下角已出现 **「壁纸」小浮窗**，随时可点 **「上传壁纸」挑一张自己喜欢的图**、拖动滑条调透明度，或按住顶部拖走 / 点「收起」；
     2. 已开启「打开即生效」——以后双击桌面或开始菜单的 `Grok Bot` 图标打开（或关到托盘重开）都会自动带上壁纸与小浮窗（若之前在任务栏固定过旧图标，取消固定后把桌面图标重新固定一次即可）。
5. **恢复默认或彻底卸载**：
   - 仅当前窗口临时还原黑白界面：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs restore
     ```
   - 彻底取消自动挂载、恢复原版快捷方式并还原默认黑白界面：
     ```powershell
     node scripts/grokbot-wallpaper-win.mjs uninstall
     ```
