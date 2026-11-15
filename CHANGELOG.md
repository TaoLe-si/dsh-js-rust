# Changelog

## 0.1.0

首个版本。

- **转译器**：JS 数值子集 → Rust（f64 / bool），带类型推断（参数类型由调用点迭代回填，冲突即报错）。
- **编译器**：调用 rustc（`-O`），按源码内容 SHA-256 缓存产物，重复编译直接命中。
- **差分测试**：26 组输入同时跑 Node 与编译后的 Rust，逐项比对，防语义漂移。
- **CLI**：`doctor` / `transpile` / `compile` / `run`。
- **DSH 插件**：`/api/js-rust/{health,transpile,compile}` 三个路由。
- **Node 运行时垫片**：`console.log` → `println!`；`Math.*` → Rust，其中 `round` / `sign` / `min` / `max`
  用 helper 保持 JS 语义（.5 取整方向、`-0`、NaN 传播）。
- 实测 `fib(30)x40`：Node ≈280ms vs Rust ≈4ms（含进程启动），≈70x。

## 0.2.0

- **子集扩展**：新增 string 与 number[]（f64[]）——字面量、拼接、下标、.length、.push。
- **类型标注**：//! types: text:string nums:f64[]，用于没有调用点的独立函数。
- **修复类型推断顺序**：递归函数在推断自身签名前需能查到目标函数，改为先建临时签名表再迭代收敛。
- **新增 bin/survey.mjs**：对目录做覆盖率扫描，按首个阻断原因归类（可行性度量）。

### 实测覆盖率（重要）

对 DSH 宿主包（61 文件）与 profile 插件（40 文件）扫描：**可转译 0.00%**。
阻塞分布：模板字符串（反引号）41%、ESM 模块语法 41%、正则字面量约 10%。
结论：把 DSH 转成 Rust 需要先实现模板字符串、箭头函数、ESM、class、async——
那已经是「写一个 JS 引擎」，不是转译器。
