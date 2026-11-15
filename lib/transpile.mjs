/**
 * JS 数值子集 -> Rust 代码生成。
 *
 * 类型只有两种：f64 与 bool。参数类型由调用点与用法迭代推断，
 * 推断冲突会直接报错而不是退化成 f64（静默改语义是不可接受的）。
 */

import { tokenize, parse } from './parser.mjs'

const MAX_ROUNDS = 8

/**
 * Node/JS 运行时垫片：把计算代码最常用的全局映射到 Rust。
 *
 * 只覆盖**纯计算**的全局。fs / net / child_process / process 这类真实 I/O 与宿主环境
 * 无法转译，命中会直接报错——假装支持它们只会产出跑不起来的东西。
 */
const MATH_CONSTANTS = {
  'Math.PI': 'std::f64::consts::PI',
  'Math.E': 'std::f64::consts::E',
}

/** Math 函数 -> 生成表达式；需要保 JS 语义的走 helper。 */
const MATH_FUNCTIONS = {
  'Math.floor': (args) => '(' + args[0] + ').floor()',
  'Math.ceil': (args) => '(' + args[0] + ').ceil()',
  'Math.trunc': (args) => '(' + args[0] + ').trunc()',
  'Math.abs': (args) => '(' + args[0] + ').abs()',
  'Math.sqrt': (args) => '(' + args[0] + ').sqrt()',
  'Math.pow': (args) => '(' + args[0] + ').powf(' + args[1] + ')',
  // JS 的 round/sign 与 Rust 语义不同，必须用 helper，见 PRELUDE
  'Math.round': (args) => 'js_round(' + args[0] + ')',
  'Math.sign': (args) => 'js_sign(' + args[0] + ')',
  'Math.min': (args) => 'js_min(&[' + args.join(', ') + '])',
  'Math.max': (args) => 'js_max(&[' + args.join(', ') + '])',
}

/** 生成文件头：helper 实现 + 允许 lint。 */
const PRELUDE = [
  '// 由 dsh-js-rust 自动生成，请勿手改。',
  '#![allow(unused_variables, unused_mut, unused_assignments, unused_parens, unused_braces, dead_code)]',
  '',
  '// JS Math.round：.5 向 +∞ 取整（Rust 的 round 是远离零，负数会差 1），',
  '// 并且保留 -0：JS 里 Math.round(-0.5) === -0，与 +0 不是同一值。',
  'fn js_round(x: f64) -> f64 {',
  '    if !x.is_finite() { return x; }',
  '    let rounded = (x + 0.5).floor();',
  '    if rounded == 0.0 && x < 0.0 { -0.0 } else { rounded }',
  '}',
  '',
  '// JS Math.sign(0) 是 0；Rust 的 signum(0.0) 是 1.0。',
  'fn js_sign(x: f64) -> f64 {',
  '    if x.is_nan() { f64::NAN } else if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { x }',
  '}',
  '',
  '// JS Math.min/max 遇到 NaN 返回 NaN；f64::min 会忽略 NaN。',
  'fn js_min(xs: &[f64]) -> f64 {',
  '    let mut acc = f64::INFINITY;',
  '    for &x in xs { if x.is_nan() { return f64::NAN; } if x < acc { acc = x; } }',
  '    acc',
  '}',
  'fn js_max(xs: &[f64]) -> f64 {',
  '    let mut acc = f64::NEG_INFINITY;',
  '    for &x in xs { if x.is_nan() { return f64::NAN; } if x > acc { acc = x; } }',
  '    acc',
  '}',
  '',
].join('\n')

/** 表达式类型推断。scope: Map<string,'f64'|'bool'> */
function typeOf(node, scope, fnTypes) {
  switch (node.type) {
    case 'Number': return 'f64'
    case 'Boolean': return 'bool'
    case 'Ident': {
      if (!scope.has(node.name)) throw new SyntaxError('未声明的标识符: ' + node.name)
      return scope.get(node.name)
    }
    case 'Unary': return node.operator === '!' ? 'bool' : 'f64'
    case 'Binary': return ['==', '!=', '<', '<=', '>', '>='].includes(node.operator) ? 'bool' : 'f64'
    case 'Logical': return 'bool'
    case 'Conditional': {
      const a = typeOf(node.consequent, scope, fnTypes)
      const b = typeOf(node.alternate, scope, fnTypes)
      if (a !== b) throw new SyntaxError('三元表达式两支类型不一致: ' + a + ' / ' + b)
      return a
    }
    case 'Update': return typeOf(node.argument, scope, fnTypes)
    case 'Assign': return typeOf(node.left, scope, fnTypes)
    case 'Member': {
      // 目前只认 Math 的数值常量；其他成员访问（含 process/require/fs）明确拒绝
      const key = node.object.type === 'Ident' ? node.object.name + '.' + node.property : null
      if (key && MATH_CONSTANTS[key] !== undefined) return 'f64'
      throw new SyntaxError('子集 v0.1 只支持 Math 常量成员访问，不支持: ' + (key || node.property))
    }
    case 'Call': {
      if (node.callee.type === 'Member') {
        const label = node.callee.object.type === 'Ident' ? node.callee.object.name + '.' + node.callee.property : '?'
        if (label === 'console.log') return null
        if (MATH_FUNCTIONS[label] !== undefined) return 'f64'
        throw new SyntaxError('子集 v0.1 不支持调用 ' + label + '（Node 内置模块如 fs/net/child_process 无法转译）')
      }
      if (node.callee.type !== 'Ident') throw new SyntaxError('只支持直接调用具名函数')
      const sig = fnTypes.get(node.callee.name)
      if (!sig) throw new SyntaxError('调用了不存在的函数: ' + node.callee.name)
      if (sig.returns === null) throw new SyntaxError('函数 ' + node.callee.name + ' 没有返回值，不能用在表达式里')
      return sig.returns
    }
    default: throw new SyntaxError('未知表达式节点: ' + node.type)
  }
}

/** 收集函数体里所有 return 的表达式类型（null 表示无 return） */
function inferSignature(fn, paramTypes) {
  const scope = new Map()
  paramTypes.forEach((type, index) => scope.set(fn.params[index], type))
  const fnTypes = new Map()
  const returns = []
  const walk = (statements) => {
    for (const statement of statements) {
      if (statement.type === 'Return' && statement.argument) returns.push(typeOf(statement.argument, scope, fnTypes))
      if (statement.type === 'Var') {
        const type = statement.init ? typeOf(statement.init, scope, fnTypes) : 'f64'
        scope.set(statement.name, type)
      }
      if (statement.type === 'If') {
        typeOf(statement.test, scope, fnTypes)
        walk(statement.consequent)
        if (statement.alternate) walk(statement.alternate)
      }
      if (statement.type === 'While') { typeOf(statement.test, scope, fnTypes); walk(statement.body) }
      if (statement.type === 'For') {
        if (statement.init && statement.init.type === 'Var') scope.set(statement.init.name, 'f64')
        if (statement.test) typeOf(statement.test, scope, fnTypes)
        if (statement.update) typeOf(statement.update, scope, fnTypes)
        walk(statement.body)
      }
      if (statement.type === 'Expr') typeOf(statement.expression, scope, fnTypes)
    }
  }
  walk(fn.body)
  const unique = [...new Set(returns)]
  if (unique.length > 1) throw new SyntaxError('函数 ' + fn.name + ' 的 return 类型不一致: ' + unique.join(' / '))
  return unique.length === 0 ? null : unique[0]
}

function literal(n) {
  if (!Number.isFinite(n)) throw new SyntaxError('不支持非有限数字字面量')
  const text = String(n)
  return Number.isInteger(n) ? text + '.0' : text
}

function emitExpression(node, types) {
  switch (node.type) {
    case 'Number': return literal(node.value)
    case 'Boolean': return node.value ? 'true' : 'false'
    case 'Ident': return node.name
    case 'Unary': return '(' + node.operator + emitExpression(node.argument, types) + ')'
    case 'Binary': return '(' + emitExpression(node.left, types) + ' ' + node.operator + ' ' + emitExpression(node.right, types) + ')'
    case 'Logical': return '(' + emitExpression(node.left, types) + ' ' + node.operator + ' ' + emitExpression(node.right, types) + ')'
    case 'Conditional':
      return '(if ' + emitExpression(node.test, types) + ' { ' + emitExpression(node.consequent, types) + ' } else { ' + emitExpression(node.alternate, types) + ' })'
    case 'Update': {
      if (node.argument.type !== 'Ident') throw new SyntaxError('++/-- 只支持变量')
      const name = node.argument.name
      const delta = node.operator === '++' ? '1.0' : '1.0'
      const sign = node.operator === '++' ? '+' : '-'
      return '(' + name + ' = ' + name + ' ' + sign + ' ' + delta + ')'
    }
    case 'Assign': {
      if (node.left.type !== 'Ident') throw new SyntaxError('只支持给变量赋值')
      return '(' + node.left.name + ' ' + node.operator + ' ' + emitExpression(node.right, types) + ')'
    }
    case 'Member': {
      const key = node.object.type === 'Ident' ? node.object.name + '.' + node.property : null
      if (key && MATH_CONSTANTS[key] !== undefined) return '(' + MATH_CONSTANTS[key] + ')'
      throw new SyntaxError('不支持的成员访问: ' + (key || node.property))
    }
    case 'Call': {
      const args = node.args.map((arg) => emitExpression(arg, types))
      if (node.callee.type === 'Member') {
        const label = node.callee.object.type === 'Ident' ? node.callee.object.name + '.' + node.callee.property : '?'
        // console.log 只在语句位置有语义（返回值是 undefined），由 emitStatements 处理
        if (label === 'console.log') throw new SyntaxError('console.log 只能作为独立语句使用')
        const mapper = MATH_FUNCTIONS[label]
        if (!mapper) throw new SyntaxError('不支持的调用: ' + label)
        return mapper(args)
      }
      return node.callee.name + '(' + args.join(', ') + ')'
    }
    default: throw new SyntaxError('未知表达式: ' + node.type)
  }
}

function emitStatements(statements, indent, types, depth) {
  const pad = '    '.repeat(indent)
  const out = []
  for (const statement of statements) {
    switch (statement.type) {
      case 'Var': {
        const type = statement.init ? typeOf(statement.init, types.scope, types.fnTypes) : 'f64'
        types.scope.set(statement.name, type)
        const value = statement.init ? emitExpression(statement.init, types) : (type === 'bool' ? 'false' : '0.0')
        out.push(pad + 'let mut ' + statement.name + ': ' + type + ' = ' + value + ';')
        break
      }
      case 'Return': {
        out.push(pad + (statement.argument ? 'return ' + emitExpression(statement.argument, types) + ';' : 'return;'))
        break
      }
      case 'If': {
        out.push(pad + 'if ' + emitExpression(statement.test, types) + ' {')
        out.push(emitStatements(statement.consequent, indent + 1, types, depth))
        out.push(pad + '}')
        if (statement.alternate) {
          out.push(pad + 'else {')
          out.push(emitStatements(statement.alternate, indent + 1, types, depth))
          out.push(pad + '}')
        }
        break
      }
      case 'While': {
        out.push(pad + 'while ' + emitExpression(statement.test, types) + ' {')
        out.push(emitStatements(statement.body, indent + 1, types, depth + 1))
        out.push(pad + '}')
        break
      }
      case 'For': {
        // for 会被展开成 loop + 显式步进；子集 v0.1 禁止在 for 内用 continue（语义易错）
        if (containsContinue(statement.body)) throw new SyntaxError('子集 v0.1 不支持在 for 循环里使用 continue；请改用 while')
        out.push(pad + '{')
        if (statement.init) out.push(emitStatements([statement.init.type === 'Var' ? statement.init : { type: 'Expr', expression: statement.init }], indent + 1, types, depth + 1))
        out.push(pad + '    loop {')
        if (statement.test) out.push(pad + '        if !' + emitExpression(statement.test, types) + ' { break; }')
        out.push(emitStatements(statement.body, indent + 2, types, depth + 2))
        if (statement.update) out.push(pad + '        let _ = ' + emitExpression(statement.update, types) + ';')
        out.push(pad + '    }')
        out.push(pad + '}')
        break
      }
      case 'Break': out.push(pad + 'break;'); break
      case 'Continue': out.push(pad + 'continue;'); break
      case 'Expr': {
        const expression = statement.expression
        if (expression.type === 'Call' && expression.callee.type === 'Member' &&
            expression.callee.object.type === 'Ident' && expression.callee.object.name === 'console' &&
            expression.callee.property === 'log') {
          // Node 垫片：console.log(a, b) -> println!("{} {}", a, b)
          const count = expression.args.length
          const format = new Array(count).fill('{}').join(' ')
          const args = expression.args.map((arg) => emitExpression(arg, types)).join(', ')
          out.push(pad + 'println!("' + format + '"' + (count > 0 ? ', ' + args : '') + ');')
          break
        }
        out.push(pad + 'let _ = ' + emitExpression(expression, types) + ';')
        break
      }
      default: throw new SyntaxError('未知语句: ' + statement.type)
    }
  }
  return out.join('\n')
}

function containsContinue(statements) {
  for (const statement of statements) {
    if (statement.type === 'Continue') return true
    if (statement.type === 'If') {
      if (containsContinue(statement.consequent)) return true
      if (statement.alternate && containsContinue(statement.alternate)) return true
    }
    if (statement.type === 'While' && containsContinue(statement.body)) return true
  }
  return false
}

/**
 * 把 JS 源码转译成 Rust 源码。
 * @param {string} source JS 源码（数值子集）。
 * @returns {{ rust: string, signatures: Array<object> }} Rust 代码与函数签名。
 */
export function transpile(source) {
  const { functions } = parse(tokenize(source))
  const paramTypes = new Map()
  for (const fn of functions) paramTypes.set(fn.name, fn.params.map(() => 'f64'))

  // 迭代推断：从调用点回填参数类型，直到稳定。
  let signatures = null
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const fnTypes = new Map()
    for (const fn of functions) {
      const types = paramTypes.get(fn.name)
      fnTypes.set(fn.name, { params: types, returns: inferSignature(fn, types) })
    }
    let changed = false
    for (const fn of functions) {
      const walk = (statements) => {
        for (const statement of statements) {
          if (statement.type === 'Expr' && statement.expression.type === 'Call') checkCall(statement.expression)
          if (statement.type === 'Var' && statement.init && statement.init.type === 'Call') checkCall(statement.init)
          if (statement.type === 'Return' && statement.argument && statement.argument.type === 'Call') checkCall(statement.argument)
          if (statement.type === 'If') { walk(statement.consequent); if (statement.alternate) walk(statement.alternate) }
          if (statement.type === 'While') walk(statement.body)
          if (statement.type === 'For') walk(statement.body)
        }
      }
      const checkCall = (call) => {
        if (call.callee.type !== 'Ident') return
        const target = functions.find((item) => item.name === call.callee.name)
        if (!target) throw new SyntaxError('调用了不存在的函数: ' + call.callee.name)
        const types = paramTypes.get(target.name)
        call.args.forEach((arg, index) => {
          const scope = new Map()
          for (const item of functions) {
            const itemTypes = paramTypes.get(item.name)
            item.params.forEach((name, position) => scope.set(name, itemTypes[position]))
          }
          const argType = typeOf(arg, scope, fnTypes)
          if (types[index] !== argType) { types[index] = argType; changed = true }
        })
      }
      walk(fn.body)
    }
    signatures = functions.map((fn) => ({
      name: fn.name,
      params: paramTypes.get(fn.name),
      returns: inferSignature(fn, paramTypes.get(fn.name)),
    }))
    if (!changed) break
  }

  const fnTypes = new Map()
  for (const signature of signatures) fnTypes.set(signature.name, signature)

  const out = [PRELUDE]
  for (const fn of functions) {
    const signature = signatures.find((item) => item.name === fn.name)
    const scope = new Map()
    fn.params.forEach((name, index) => scope.set(name, signature.params[index]))
    const types = { scope, fnTypes }
    // 参数一律加 mut：JS 允许在函数体里给参数重新赋值（如 gcd/collatz），Rust 默认不可变。
    const params = fn.params.map((name, index) => 'mut ' + name + ': ' + signature.params[index]).join(', ')
    const returns = signature.returns ? ' -> ' + signature.returns : ''
    out.push('fn ' + fn.name + '(' + params + ')' + returns + ' {')
    out.push(emitStatements(fn.body, 1, types, 0))
    out.push('}')
    out.push('')
  }
  return { rust: out.join('\n'), signatures }
}
