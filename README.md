<div align="center">

# mCodex

**Codex Desktop on your phone**

Leave Codex Desktop running on your PC, and use your phone to check progress, send follow-ups, and handle approvals.

[English](README.md) · [中文](README_ZH.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/zqlrts60/mCodex/releases)

[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows)](#requirements)
[![Latest Release](https://img.shields.io/github/v/release/zqlrts60/mCodex?display_name=tag)](https://github.com/zqlrts60/mCodex/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-2f855a.svg)](LICENSE)

</div>

> [!NOTE]
> mCodex is an unofficial community project. The PC host currently supports Windows 10/11 with the Microsoft Store version of Codex Desktop or Codex++ installed and signed in.

https://github.com/user-attachments/assets/a5a2ce4b-d82e-484e-8de3-d4ceade51807

## Ways to use mCodex

### 1. Single-file EXE (recommended)

Download `mCodex-*-win-x64.exe` from [Releases](https://github.com/zqlrts60/mCodex/releases/latest), fully quit Codex Desktop, and double-click the EXE. It starts Codex Desktop and mCodex, then opens the local page automatically.

Best for most users. No Node.js or build step is required. The EXE is currently unsigned, so Windows SmartScreen may show an unknown publisher warning.

### 2. Portable ZIP

Download `mCodex-*-win-x64-portable.zip` from [Releases](https://github.com/zqlrts60/mCodex/releases/latest), extract it, fully quit Codex Desktop, and double-click `start.bat`.

Use this when you prefer an unpacked package. Node.js is included.

### 3. Source code

Requires Node.js `20.19+` or `22.12+`:

```powershell
git clone https://github.com/zqlrts60/mCodex.git
cd mCodex
.\manage.bat
```

`manage.bat` checks dependencies, builds the project, starts Codex Desktop with local control enabled, starts mCodex, and opens the local page.

## Connect your phone

### On the same network

1. Start mCodex using one of the methods above.
2. Connect the phone and PC to the same Wi-Fi or network.
3. Scan the QR code on the PC page, or open the displayed address and enter the pairing code.

The pairing code is valid for 10 minutes. After pairing, the device stays trusted until the saved token is revoked.

### Remote access

To use mCodex away from home, connect it through a private-network or tunneling tool such as Tailscale, frp, or PeanutHull, then open the resulting address on your phone. Only publish the mCodex service on port `3210`; never expose the Codex control port `9222`.

## Configuration

When running from source or the portable release, mCodex reads these environment variables. It does not load `.env` automatically; set them in the current shell or launcher before starting.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Address the Bridge binds to. Use `0.0.0.0` for phone access on the same LAN. |
| `BRIDGE_PORT` | `3210` | Web UI and API port. |
| `BRIDGE_TOKEN` | generated | Device-trust token for LAN mode. Use a random 24+ character value in external mode. |
| `BRIDGE_TOKEN_FILE` | `%USERPROFILE%\.codex\remote-bridge-token` | Where a generated device-trust token is persisted. |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | Codex Desktop session data directory. |
| `CODEX_CDP_URL` | `http://localhost:9222` | Codex control endpoint. The launcher normally discovers the real URL automatically. |
| `MCODEX_LOCALE` | system | Force `zh-CN` or `en-US` output. |

## What you can do

- Browse projects and follow live task output
- Send messages, follow-ups, and images
- Stop tasks and handle approval requests
- Inspect changed files, Git state, token usage, and cited sources
- Pin important tasks
- Create projects and start new tasks
- Switch Codex Desktop permission modes, Codex / ChatGPT Work mode, and reasoning effort

## Why mCodex?

| Common approach | Practical pain point | How mCodex differs |
| --- | --- | --- |
| **Unofficial accounts, wrappers, or relay services** | They may require cookies or tokens and route requests through third parties, increasing credential and account risk. | mCodex does not take over authentication or proxy model requests. It reuses the official session in Codex Desktop. |
| **Official ChatGPT mobile app** | It is a separate ChatGPT experience, not a mobile view of the same local Codex Desktop projects, tasks, approvals, and file changes. | mCodex keeps the current Desktop task context on your phone. |
| **Remote desktop tools** | Streaming the whole screen means tiny controls, awkward typing, scrolling, and precise clicking on a phone. | mCodex provides a responsive, touch-friendly interface focused on Codex workflows. |
| **CLI-only or infrastructure-heavy tools** | Terminal workflows are inconvenient on a phone, while multi-service deployments are excessive for one personal PC. | mCodex uses one Windows launcher, one local bridge, and a browser UI. |

## Screenshots

<p align="center">
  <img src="readme/mobile-projects.jpg" alt="mCodex project and task list on a phone" width="340">
  &nbsp;&nbsp;
  <img src="readme/mobile-task.jpg" alt="mCodex task timeline and file change card on a phone" width="340">
</p>

![mCodex startup terminal showing Codex Desktop, LAN addresses, and pairing](readme/terminal.png)

## Requirements

- Windows 10 or 11 on the host PC
- Microsoft Store version of Codex Desktop, installed and signed in
- A modern browser on the phone or another device
- Node.js only when running from source

## Important security notes

- Keep pairing enabled and protect any address exposed through a tunneling service.
- Never expose or forward the Codex CDP port `9222`.
- mCodex does not provide a public relay, user accounts, or multi-user isolation.
- Third-party tunneling and remote-network tools are supported as connection options but remain outside the project's security and availability responsibility.

See [SECURITY.md](SECURITY.md) for the full security policy.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Codex control is offline | Fully quit Codex Desktop, then start mCodex again |
| Phone cannot open the page | On the same network, check port `3210`; remotely, check the tunneling or private-network configuration |
| Pairing code expired | Restart mCodex to generate a new code |
| Startup failed | For source/portable installs, run `manage.bat logs` |

## Friends

- [**linux.do**](https://linux.do/)

## License

[MIT](LICENSE)
