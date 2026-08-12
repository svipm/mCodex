# 发布检查清单

每次发布前按顺序执行以下步骤：

1. 安装依赖并做本地检查

   ```powershell
   npm ci
   npm run check
   ```

   `npm run check` 会依次运行 typecheck、测试和生产构建。

2. 真实桌面冒烟测试（只读）

   确保 Codex Desktop 与 mCodex Bridge 已运行，然后执行：

   ```powershell
   npm run smoke
   ```

3. 构建全部发布产物

   ```powershell
   npm run release
   ```

   产物包括 source zip、portable zip 和 SEA EXE；SEA 打包完成后会自动执行 `--self-test` 验证资源释放。

4. 触发远程 CI

   ```powershell
   gh workflow run CI --repo svipm/mCodex --ref main
   ```

5. 打标签并发布

   ```powershell
   git tag v<版本>
   git push origin v<版本>
   gh workflow run Release --repo svipm/mCodex --ref v<版本>
   ```

6. 检查 GitHub Release 中的 EXE、zip 和 sha256 文件是否齐全

> 注意：当前仓库是 fork，push 到 `main` 不会自动创建 CI 运行记录，需要手动触发；标签推送如果同样不触发，也请使用 `gh workflow run` 手动触发 Release。
