# Grok Bot 换壁纸背景（Windows 适配开源版）

每天对着 Grok Bot 默认的黑白聊天框是不是早就看腻了？

原版 `grokbot-wallpaper` 只支持 macOS，Windows 电脑直接装会报错退出。于是我专门重写适配了这版 **Windows 桌面客户端可用的换壁纸 Skill**（同时兼容 macOS）——不用破解客户端、不改 `app.asar` 安装包，装好后直接在右下角点 **「上传壁纸」**，挑一张你喜欢的图就能换上！

![Windows 实机壁纸效果（聊天区已脱敏）](docs/preview-window.png)

仓库内置了一张按社区“DeepSeek娘 / 蓝色大肥鱼”二创人设生成的原创示例壁纸（[`examples/deepseek-whale-girl.png`](examples/deepseek-whale-girl.png)，1.85MB），开箱就能直接试效果。

---

## 零代码怎么用（推荐）

只需要 3 步：

1. **发一句话给你的 Grok Bot（Agent）**：
   > 「帮我安装这个 Windows 版 Grok Bot 换壁纸技能，并把壁纸面板挂出来：`<本仓库 GitHub 地址>`」
2. **挑一张你喜欢的图**：
   窗口右下角会弹出「壁纸」小浮窗，点 **「上传壁纸」**，从电脑里选一张你喜欢的图片（支持 `PNG / JPG / WEBP`，大小不超过 `4MB`）。
3. **调一个舒服的透明度**：
   拖动面板上的滑条实时调背景透出感（实测深色保护模式下 `0.88` 最舒服，看聊天文字清清楚楚，底下又能透出壁纸轮廓）。面板顶部可以按住拖走或点「收起」，不挡输入框。

---

## 使用前须知（安全与限制）

- **支持环境**：Windows 10 / 11 官方桌面版 `Grok Bot`（实测 `1.0.1`），兼容 macOS；需本机装有 `Node.js 22+`。
- **不改官方文件**：本质是运行时页面覆盖层，**不会修改官方安装包、`Grok Bot.exe` 或 `app.asar`**，也不写系统开机自启注册表。
- **首次开启需重开一次窗口**：第一次挂载壁纸面板时，需要在本机回环地址（`127.0.0.1:19222`）开启调试连接，Agent 会先提醒你保存当前对话再重开窗口；之后换图、拉滑条都**不需要**再重启。
- **图片不上云**：选中的图片只保存在你电脑本机 `%LOCALAPPDATA%\grokbot-wallpaper-win\` 目录下，绝不上传外网或图床。
- **退出还原机制**：点 `restore` 命令可立即移除背景恢复默认黑白界面；彻底退出 Grok Bot 客户端进程后，临时覆盖层也会自动失效。

---

## 命令行手动体验（可选）

如果你习惯自己在 PowerShell / 终端运行（需 Node.js 22+）：

```powershell
# 查看当前 Grok Bot 与壁纸状态
node scripts/grokbot-wallpaper-win.mjs status

# 直接挂出壁纸面板（首次启用加 --relaunch）
node scripts/grokbot-wallpaper-win.mjs init --relaunch

# 或者直接换上仓库自带的“蓝色大肥鱼”示例壁纸，透明度设为 0.88
node scripts/grokbot-wallpaper-win.mjs apply "examples/deepseek-whale-girl.png" --opacity 0.88 --dark

# 随时一键恢复默认界面
node scripts/grokbot-wallpaper-win.mjs restore
```

给 Agent 读取的完整执行规范见 [SKILL.md](SKILL.md)。

---

## 致谢与声明

- 灵感致谢：受 [Kin](https://x.com/KinGao476942/status/2121763505665876302) 开源的 macOS 版 [`KinGao294/grokbot-wallpaper`](https://github.com/KinGao294/grokbot-wallpaper) 启发，本仓库为面向 Windows 官方客户端独立编写的 MIT 开源实现。
- 形象声明：`examples/deepseek-whale-girl.png` 为按社区“DeepSeek娘 / 鲸鱼娘 / 蓝色大肥鱼”同人二创设定生成的原创插画，非 DeepSeek 官方形象；本工具亦非 Grok Bot 官方出品。
