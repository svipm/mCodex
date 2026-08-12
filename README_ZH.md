<div align="center">

# mCodex

**手机通过网页控制 Codex Desktop**

Codex Desktop 留在电脑上，随时用手机查看进度、追加指令和处理审批。

[English](README.md) · [中文](README_ZH.md) · [更新日志](CHANGELOG.md) · [版本下载](https://github.com/zqlrts60/mCodex/releases)

[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows)](#环境要求)
[![最新版本](https://img.shields.io/github/v/release/zqlrts60/mCodex?display_name=tag&label=release)](https://github.com/zqlrts60/mCodex/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-2f855a.svg)](LICENSE)

</div>

> [!NOTE]
> mCodex 是非官方社区项目。电脑端目前支持 Windows 10/11，并要求安装且登录 Microsoft Store 版 Codex Desktop 或 Codex++。

https://github.com/user-attachments/assets/a5a2ce4b-d82e-484e-8de3-d4ceade51807

## 使用方式

### 1. 单文件 EXE（推荐）

从 [Releases](https://github.com/zqlrts60/mCodex/releases/latest) 下载 `mCodex-*-win-x64.exe`，完全退出 Codex Desktop，然后双击 EXE。程序会自动启动 Codex Desktop 和 mCodex，并打开电脑端页面。

适合大多数用户，不需要安装 Node.js，也不需要构建。EXE 暂未签名，Windows SmartScreen 可能提示“未知发布者”。

### 2. 便携 ZIP

从 [Releases](https://github.com/zqlrts60/mCodex/releases/latest) 下载 `mCodex-*-win-x64-portable.zip`，解压后完全退出 Codex Desktop，再双击 `start.bat`。

适合希望使用解压版的用户，包内已包含 Node.js。

### 3. 源码一键启动

需要 Node.js `20.19+` 或 `22.12+`：

```powershell
git clone https://github.com/zqlrts60/mCodex.git
cd mCodex
.\manage.bat
```

`manage.bat` 会检查依赖、构建项目、以本地控制模式启动 Codex Desktop、启动 mCodex，并自动打开电脑端页面。mCodex 运行时，可执行 `npm run smoke` 对本地 Bridge 做只读端到端自检。

## 手机连接

### 同一网络

1. 使用上面任意一种方式启动 mCodex。
2. 手机和电脑连接同一个 Wi-Fi 或网络。
3. 扫描电脑页面上的二维码，或打开页面显示的地址并输入配对码。

配对码有效期为 10 分钟。配对成功后，设备会保持信任，直到保存的 Token 被撤销。

### 远程访问

需要在外网使用时，可以搭配 Tailscale、frp、花生壳等组网或内网穿透工具，再用手机打开工具提供的访问地址。只允许转发 mCodex 的 `3210` 端口，任何情况下都不要暴露 Codex 控制端口 `9222`。

## 配置

从源码或便携版运行时，mCodex 会读取以下环境变量。它不会自动加载 `.env`；请先在当前终端或启动器中设置。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Bridge 绑定的地址；手机需要同一局域网访问时设为 `0.0.0.0`。 |
| `BRIDGE_PORT` | `3210` | 网页和 API 端口。 |
| `BRIDGE_TOKEN` | 自动生成 | 局域网模式的设备信任 Token；外网模式请使用至少 24 个字符的随机值。 |
| `BRIDGE_TOKEN_FILE` | `%USERPROFILE%\.codex\remote-bridge-token` | 自动生成的设备信任 Token 保存位置。 |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | Codex Desktop 会话数据目录。 |
| `CODEX_CDP_URL` | `http://localhost:9222` | Codex 控制端口；启动脚本通常会自动发现真实地址。 |
| `MCODEX_LOCALE` | 跟随系统 | 强制使用 `zh-CN` 或 `en-US` 输出。 |

## 可以做什么

- 按项目浏览任务并跟进实时输出
- 发送消息、后续指令和图片
- 停止任务并处理审批请求
- 查看修改文件、Git 状态、Token 用量和引用来源
- 置顶重要任务
- 创建项目和新任务
- 切换 Codex Desktop 权限模式、Codex / ChatGPT Work 模式和推理强度

## 为什么需要 mCodex？

| 常见方案 | 实际痛点 | mCodex 的处理方式 |
| --- | --- | --- |
| **非官方账号、套壳客户端或中转服务** | 可能要求提交 Cookie、Token，或把请求发送到第三方中转，增加凭据与账号风险。 | mCodex 不接管登录、不代理模型请求，只复用 Codex Desktop 已有的官方登录态。 |
| **官方 ChatGPT 手机 App** | 它是独立的 ChatGPT 使用体验，并不是本机 Codex Desktop 项目、任务、审批和文件修改的移动视图。 | mCodex 可以直接在手机上保留当前 Desktop 任务上下文。 |
| **远程桌面工具** | 传输整个屏幕，手机上按钮细小，输入、滚动和精确点击都不方便。 | mCodex 提供响应式、触控友好的 Codex 工作界面。 |
| **仅支持 CLI 或架构复杂的工具** | CLI 不适合手机操作，多服务部署对控制一台个人电脑又过于复杂。 | mCodex 只需一个 Windows 启动入口、一个本地 Bridge 和浏览器界面。 |

## 界面预览

<p align="center">
  <img src="readme/mobile-projects.jpg" alt="手机上的 mCodex 项目与任务列表" width="340">
  &nbsp;&nbsp;
  <img src="readme/mobile-task.jpg" alt="手机上的 mCodex 任务时间线与文件修改卡片" width="340">
</p>

![mCodex 启动终端，显示 Codex Desktop、局域网地址与配对信息](readme/terminal.png)

## 环境要求

- 电脑端为 Windows 10 或 11
- 已安装并登录 Microsoft Store 版 Codex Desktop
- 手机或其他设备使用现代浏览器
- 仅源码方式需要 Node.js

## 重要安全提示

- 使用内网穿透时保留配对鉴权，并妥善保护对外访问地址。
- 不要暴露或转发 Codex CDP 端口 `9222`。
- mCodex 不提供公网中转、用户账号或多用户隔离。
- 第三方内网穿透和远程组网可以作为连接方式，但其安全性和可用性由对应工具及使用者负责。

完整说明见 [SECURITY.md](SECURITY.md)。

## 故障排查

| 现象 | 处理方式 |
| --- | --- |
| Codex 控制离线 | 完全退出 Codex Desktop，再重新启动 mCodex |
| 手机打不开页面 | 同一网络下检查 `3210` 端口；远程使用时检查组网或内网穿透配置 |
| 配对码失效 | 重启 mCodex 获取新的配对码 |
| 启动失败 | 源码版或便携版可运行 `manage.bat logs` 查看日志 |

## 友情链接

- [**linux.do**](https://linux.do/)

## 许可证

本项目采用 [MIT License](LICENSE)。
