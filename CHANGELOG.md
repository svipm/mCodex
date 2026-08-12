# 更新记录

## [Unreleased]

### Added

- 支持 Codex++（增强版 Codex Desktop），自动发现随机 CDP 控制端口
- 手机端切换 Codex / ChatGPT Work 模式和推理强度
- 任务环境面板：Git 分支与变更、Token 用量、引用来源
- 置顶任务、桌面风格导航和顶栏菜单
- 空状态直接选择项目并新建任务
- 对话步骤编号
- `npm run smoke` 只读端到端冒烟测试
- SEA 打包后自动执行 `--self-test` 验证资源释放

### Changed

- 环境信息按会话文件变化缓存，降低 Git 轮询开销
- 启动脚本可自动定位 ChatGPT.exe 的随机调试端口
- Bridge 支持依赖注入，新增 HTTP API 与 WebSocket 集成测试

## [0.1.0] - 2026-08-07

### Added

- 通过局域网网页查看和操作 Codex Desktop 任务
- 会话时间线、实时运行状态和图片消息
- 消息发送、停止、审批和后续指令
- 项目和新任务创建
- 配对码和设备信任 Token
- Windows source、portable 和 SEA EXE 发布形式
- 配对信息仅允许本机读取，并限制 API 查询参数 Token 的使用范围

### Notes

- 当前版本为 experimental。
- 仅支持 Windows 10/11 和 Windows Store 版 Codex Desktop。
- Codex Desktop 更新后，CDP selector 变化可能影响控制功能。
