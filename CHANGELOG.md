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
