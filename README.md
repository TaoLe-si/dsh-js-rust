# dsh-js-rust

把**受支持的 JS 数值子集**转译成 Rust，并调用本地 `rustc` 编译成可执行文件。
核心原则：**只转译能证明等价的代码**，子集之外的语法一律报错，绝不猜测。

## 先读这段：边界（很重要）

它**不能**把 DSH 后端换成 Rust，也不转译 DSH 插件。原因是硬性的：

- DSH 的插件在运行期按 `cordis.patch.yml` / `dsh.profile.bundles` 动态 `import()`，
  配置里还有 `!!js` 表达式在加载时求值——AOT 转译器在编译期无法确定要加载什么；
- 插件契约是动态的：`ctx.inject` / `ctx.on` 注册回调，cordis waterfall 用
  `Reflect.apply(callback, thisArg, [...args, next])` 变参派发，`llm/stream` 返回 async generator。
  要等价表达这些，需要动态类型 + GC + 事件调度，那是**写一个 JS 引擎**，不是转译器；
- 还依赖 V8 语义：`structuredClone`、`deepFreeze`、symbol 键、`snapshotJsonValue` 的无损往返。

**它真正适合的场景**：把你自己的**数值热点**（纯计算、无副作用）换成原生实现。

## 支持的子集（v0.1）

- **类型**：`number`（f64）、`boolean`、`string`、`number[]`（f64[]）
- **语句**：`let` / `const` / `var`、`if` / `else`、`while`、`for`、`return`、`break`、
  `continue`（`for` 内不支持 `continue`，会明确报错，请改用 `while`）
- **运算**：`+ - * / %`、`< <= > >=`、`== != === !==`、`&&` `||` `!`、三元 `?:`、
  `+= -= *= /= %=`、`++` `--`
- **函数**：声明、调用、递归；参数与返回值类型由调用点迭代推断，冲突即报错
- **字符串**：字面量、+ 拼接（含与数字强转）、== / !=、.length
- **数组**：[1,2,3] 字面量、下标读写、.length、.push()（仅 number 数组）
- **Node / JS 运行时垫片**：console.log（→ println!）、Math.floor/ceil/trunc/abs/sqrt/pow/round/sign/min/max、Math.PI、Math.E
- **类型标注**：独立函数没有调用点可推断时，用 //! types: s:string a:f64[] 声明参数类型
- **不支持**：字符串、数组、对象、闭包、async、try/catch、类、switch、解构、可选链，
  以及 **`fs` / `net` / `child_process` / `process` 等真实 I/O 与宿主 API**

超出子集会抛出**带行号**的 `SyntaxError`，不会静默降级。

## 用法

```bash
node bin/jsrust.mjs doctor            # 检查 rustc
node bin/jsrust.mjs transpile a.js     # 打印生成的 Rust
node bin/jsrust.mjs compile a.js       # 编译成 exe（按内容哈希缓存）
node bin/jsrust.mjs run a.js fib 20    # 编译并直接调用
node test/benchmark.mjs                # JS vs Rust 基准
node --test test/differential.mjs      # 差分测试
```

## 验证方式：差分测试（核心）

`test/differential.mjs` 把同一份 JS **分别**用 Node 执行、用 rustc 编译后执行，逐组比对结果。
这是唯一能证明「转译没有静默改语义」的手段，所以它是这个项目的核心测试，
覆盖递归、while、for、布尔返回、三元、参数重赋值共 26 组输入。

实测基准（本机，`fib(30) × 40`）：

```
Node (JS) : 276.8 ms
Rust (-O) :   3.9 ms   (含进程启动)
加速比    :  71.5x     结果一致
```

## 插件接口

- `GET  /api/js-rust/health` —— 版本与 rustc 可用性
- `POST /api/js-rust/transpile` —— `{ source }` → 生成的 Rust 源码
- `POST /api/js-rust/compile` —— `{ source }` → 编译产物路径

`transpile` / `compile` 需要 `x-dsh-plugin: js-rust` 请求头。

## Node 运行时垫片

| 垫片 | 映射 | 为什么需要 helper |
| --- | --- | --- |
| `console.log(a, b)` | `println!("{} {}", a, b)` | 仅语句位置；返回 undefined，不能用在表达式里 |
| `Math.floor/ceil/trunc/abs/sqrt/pow` | 对应 `f64` 方法 | 语义一致，直接映射 |
| `Math.round` | `js_round` | **JS 的 .5 向 +∞ 取整**，Rust `round` 远离零，负数差 1；还要保留 `-0` |
| `Math.sign` | `js_sign` | JS `Math.sign(0)` 是 0，Rust `signum(0.0)` 是 1.0 |
| `Math.min/max` | `js_min` / `js_max` | JS 遇 NaN 返回 NaN，`f64::min` 会忽略 NaN |
| `Math.PI` / `Math.E` | 对应常量 | — |

这些都是「能编译但结果错」的隐蔽坑，所以统一用 helper 实现并纳入差分测试。
**`fs` / `net` / `child_process` / `process` 不在垫片范围内**——它们依赖宿主环境，
转译过去只会产出跑不起来的东西，命中会直接报错。

## 工具链

需要 `rustc`：在 PATH 中、或 rustup 默认安装位置（`~/.cargo/bin`）均可。
未安装时 `doctor` 与 `/health` 都会给出明确提示。

## License

MIT
