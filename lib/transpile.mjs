/**
 * JS 数值子集 -> Rust 代码生成。
 *
 * 类型只有两种：f64 与 bool。参数类型由调用点与用法迭代推断，
 * 推断冲突会直接报错而不是退化成 f64（静默改语义是不可接受的）。
 */

import { tokenize, parse } from './parser.mjs'

const MAX_ROUNDS = 8

/**
 * 校验正则模式是否落在支持的子集内。
 *
 * 支持：字面量、`.`、`*` `+` `?`、`[...]`（含范围与 `^` 取反）、`^` `$`、
 * `\\d \\D \\w \\W \\s \\S` 与转义。不支持分组与交替——它们是另一个量级的实现，
 * 与其给出「看起来能跑」的结果，不如明确拒绝。
 *
 * @param {string} pattern 正则源文本。
 * @returns {void}
 */
function validateRegExp(pattern) {
  for (const forbidden of ['(', ')', '|', '{', '}']) {
    if (pattern.includes(forbidden)) {
      throw new SyntaxError('正则不支持 ' + forbidden + '（分组/交替/量词区间），模式: /' + pattern + '/')
    }
  }
}

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
  '#![allow(unused_variables, unused_mut, unused_assignments, unused_parens, unused_braces, dead_code, non_camel_case_types)]',
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
  // ── 极简正则引擎（仅支持子集：字面量/./*/+/ ?/[]/^/$/\d 等） ──
  "#[derive(Clone, Debug)]\n",
  "enum RAtom { Lit(char), Any, Class(Vec<(char, char)>, bool), Digit(bool), Word(bool), Space(bool) }\n",
  "\n",
  "#[derive(Clone, Debug)]\n",
  "enum RPart { One(RAtom), Star(RAtom), Plus(RAtom), Opt(RAtom) }\n",
  "\n",
  "fn atom_match(atom: &RAtom, c: char) -> bool {\n",
  "    match atom {\n",
  "        RAtom::Lit(x) => *x == c,\n",
  "        RAtom::Any => c != '\\n',\n",
  "        RAtom::Class(ranges, neg) => {\n",
  "            let mut hit = false;\n",
  "            for (lo, hi) in ranges { if c >= *lo && c <= *hi { hit = true; break } }\n",
  "            if *neg { !hit } else { hit }\n",
  "        }\n",
  "        RAtom::Digit(neg) => c.is_ascii_digit() != *neg,\n",
  "        RAtom::Word(neg) => (c.is_ascii_alphanumeric() || c == '_') != *neg,\n",
  "        RAtom::Space(neg) => c.is_whitespace() != *neg,\n",
  "    }\n",
  "}\n",
  "\n",
  "fn match_here(parts: &[RPart], text: &[char], pi: usize, ti: usize) -> Option<usize> {\n",
  "    if pi == parts.len() { return Some(ti) }\n",
  "    match &parts[pi] {\n",
  "        RPart::One(atom) => {\n",
  "            if ti < text.len() && atom_match(atom, text[ti]) { match_here(parts, text, pi + 1, ti + 1) } else { None }\n",
  "        }\n",
  "        RPart::Opt(atom) => {\n",
  "            if ti < text.len() && atom_match(atom, text[ti]) {\n",
  "                if let Some(end) = match_here(parts, text, pi + 1, ti + 1) { return Some(end) }\n",
  "            }\n",
  "            match_here(parts, text, pi + 1, ti)\n",
  "        }\n",
  "        RPart::Star(atom) => {\n",
  "            let mut end = ti;\n",
  "            while end < text.len() && atom_match(atom, text[end]) { end += 1 }\n",
  "            loop {\n",
  "                if let Some(found) = match_here(parts, text, pi + 1, end) { return Some(found) }\n",
  "                if end == ti { return None }\n",
  "                end -= 1;\n",
  "            }\n",
  "        }\n",
  "        RPart::Plus(atom) => {\n",
  "            if !(ti < text.len() && atom_match(atom, text[ti])) { return None }\n",
  "            let mut end = ti;\n",
  "            while end < text.len() && atom_match(atom, text[end]) { end += 1 }\n",
  "            loop {\n",
  "                if let Some(found) = match_here(parts, text, pi + 1, end) { return Some(found) }\n",
  "                if end == ti + 1 { return None }\n",
  "                end -= 1;\n",
  "            }\n",
  "        }\n",
  "    }\n",
  "}\n",
  "\n",
  "fn js_regex_test(pattern: &str, flags: &str, subject: &str) -> bool {\n",
  "    let case_insensitive = flags.contains('i');\n",
  "    let raw: Vec<char> = pattern.chars().collect();\n",
  "    let mut parts: Vec<RPart> = Vec::new();\n",
  "    let mut anchor_start = false;\n",
  "    let mut anchor_end = false;\n",
  "    let mut i = 0usize;\n",
  "    let fold = |c: char| if case_insensitive { c.to_ascii_lowercase() } else { c };\n",
  "    while i < raw.len() {\n",
  "        let c = raw[i];\n",
  "        if c == '^' && parts.is_empty() { anchor_start = true; i += 1; continue }\n",
  "        if c == '$' && i + 1 == raw.len() { anchor_end = true; i += 1; continue }\n",
  "        let atom = if c == '.' { i += 1; RAtom::Any }\n",
  "            else if c == '[' {\n",
  "                i += 1;\n",
  "                let mut neg = false;\n",
  "                if i < raw.len() && raw[i] == '^' { neg = true; i += 1 }\n",
  "                let mut ranges: Vec<(char, char)> = Vec::new();\n",
  "                while i < raw.len() && raw[i] != ']' {\n",
  "                    let lo = fold(raw[i]);\n",
  "                    i += 1;\n",
  "                    if i + 1 < raw.len() && raw[i] == '-' && raw[i + 1] != ']' {\n",
  "                        let hi = fold(raw[i + 1]);\n",
  "                        ranges.push((lo, hi));\n",
  "                        i += 2;\n",
  "                    } else {\n",
  "                        ranges.push((lo, lo));\n",
  "                    }\n",
  "                }\n",
  "                i += 1;\n",
  "                RAtom::Class(ranges, neg)\n",
  "            }\n",
  "            else if c == '\\\\' {\n",
  "                i += 1;\n",
  "                let e = raw[i];\n",
  "                i += 1;\n",
  "                match e {\n",
  "                    'd' => RAtom::Digit(false), 'D' => RAtom::Digit(true),\n",
  "                    'w' => RAtom::Word(false), 'W' => RAtom::Word(true),\n",
  "                    's' => RAtom::Space(false), 'S' => RAtom::Space(true),\n",
  "                    'n' => RAtom::Lit('\\n'), 't' => RAtom::Lit('\\t'),\n",
  "                    other => RAtom::Lit(fold(other)),\n",
  "                }\n",
  "            } else { i += 1; RAtom::Lit(fold(c)) };\n",
  "        part_quant(&raw, &mut i, atom, &mut parts);\n",
  "    }\n",
  "    let text: Vec<char> = subject.chars().map(|c| if case_insensitive { c.to_ascii_lowercase() } else { c }).collect();\n",
  "    let mut start = 0usize;\n",
  "    loop {\n",
  "        if let Some(end) = match_here(&parts, &text, 0, start) {\n",
  "            if !anchor_end || end == text.len() { return true }\n",
  "        }\n",
  "        if anchor_start { break }\n",
  "        if start >= text.len() { break }\n",
  "        start += 1;\n",
  "    }\n",
  "    false\n",
  "}\n",
  "\n",
  "fn part_quant(raw: &[char], i: &mut usize, atom: RAtom, parts: &mut Vec<RPart>) {\n",
  "    if *i < raw.len() && raw[*i] == '*' { *i += 1; parts.push(RPart::Star(atom)); }\n",
  "    else if *i < raw.len() && raw[*i] == '+' { *i += 1; parts.push(RPart::Plus(atom)); }\n",
  "    else if *i < raw.len() && raw[*i] == '?' { *i += 1; parts.push(RPart::Opt(atom)); }\n",
  "    else { parts.push(RPart::One(atom)) }\n",
  "}\n",
].join('\n')

/** 表达式类型推断。scope: Map<string,'f64'|'bool'> */
function typeOf(node, scope, fnTypes) {
  switch (node.type) {
    case 'Number': return 'f64'
    case 'String': return 'string'
    case 'Template': return 'string'
    case 'Boolean': return 'bool'
    case 'Array': {
      for (const element of node.elements) {
        if (typeOf(element, scope, fnTypes) !== 'f64') throw new SyntaxError('数组元素只支持 number')
      }
      return 'f64[]'
    }
    case 'Index': {
      const object = typeOf(node.object, scope, fnTypes)
      if (object !== 'f64[]') throw new SyntaxError('只有 number 数组支持下标访问，实际: ' + object)
      if (typeOf(node.index, scope, fnTypes) !== 'f64') throw new SyntaxError('下标必须是 number')
      return 'f64'
    }
    case 'RegExp': {
      validateRegExp(node.pattern)
      return 'regex'
    }
    case 'New': return 'class:' + node.callee
    case 'Ident': {
      if (scope.has(node.name)) return scope.get(node.name)
      // 跨模块名字：类型未知时按数值处理（v0 限制，见 README）
      if (fnTypes.importMap && fnTypes.importMap.has(node.name)) return 'f64'
      throw new SyntaxError('未声明的标识符: ' + node.name)
    }
    case 'Unary': return node.operator === '!' ? 'bool' : 'f64'
    case 'Binary': {
      if (['==', '!=', '<', '<=', '>', '>='].includes(node.operator)) {
        const leftType = typeOf(node.left, scope, fnTypes)
        const rightType = typeOf(node.right, scope, fnTypes)
        if (leftType === 'f64[]' || rightType === 'f64[]') throw new SyntaxError('数组不能直接比较')
        return 'bool'
      }
      const left = typeOf(node.left, scope, fnTypes)
      const right = typeOf(node.right, scope, fnTypes)
      if (node.operator === '+') {
        if (left === 'string' || right === 'string') {
          // JS 的 + 遇到字符串会把另一侧强制转成字符串（"n=" + 7 => "n=7"）。
          // Rust 侧用 format! 的 Display 做同样的事；f64/bool/String 都实现了 Display。
          if (left === 'f64[]' || right === 'f64[]') throw new SyntaxError('数组不能参与字符串拼接')
          return 'string'
        }
        if (left !== 'f64' || right !== 'f64') throw new SyntaxError('+ 只支持 number 或 string')
        return 'f64'
      }
      if (left !== 'f64' || right !== 'f64') throw new SyntaxError(node.operator + ' 只支持 number')
      return 'f64'
    }
    case 'Logical': return 'bool'
    case 'Conditional': {
      const a = typeOf(node.consequent, scope, fnTypes)
      const b = typeOf(node.alternate, scope, fnTypes)
      if (a !== b) throw new SyntaxError('三元表达式两支类型不一致: ' + a + ' / ' + b)
      return a
    }
    case 'Update': return typeOf(node.argument, scope, fnTypes)
    case 'Assign': return typeOf(node.left, scope, fnTypes)
    case 'ObjectLiteral': {
      // 展开：{ ...base, k: v } 合并成新形状，后写字段覆盖前写
      const merged = []
      for (const property of node.properties) {
        if (property.spread) {
          const baseType = typeOf(property.value, scope, fnTypes)
          if (!baseType.startsWith('obj:')) {
            throw new SyntaxError('对象展开只支持已知形状的对象，实际 ' + baseType)
          }
          for (const field of fnTypes.shapes.fieldsOf(baseType.slice(4))) {
            const at = merged.findIndex((item) => item.name === field.name)
            if (at >= 0) merged[at] = field
            else merged.push(field)
          }
          continue
        }
        const entry = { name: property.key, type: typeOf(property.value, scope, fnTypes) }
        const at = merged.findIndex((item) => item.name === property.key)
        if (at >= 0) merged[at] = entry
        else merged.push(entry)
      }
      const fields = merged
      for (const field of fields) {
        if (!['f64', 'bool', 'string'].includes(field.type)) {
          throw new SyntaxError('对象字段只支持 number/boolean/string，字段 ' + field.name + ' 是 ' + field.type)
        }
      }
      if (!fnTypes.shapes) throw new SyntaxError('内部错误：缺少 shapes 注册表')
      return 'obj:' + fnTypes.shapes.register(fields)
    }
    case 'Member': {
      if (node.property === 'length') {
        const object = typeOf(node.object, scope, fnTypes)
        if (object === 'f64[]' || object === 'string') return 'f64'
        throw new SyntaxError('.length 只支持数组与字符串，实际: ' + object)
      }
      // 常量必须最先判：否则 typeOf(Math) 会先抛「未声明的标识符」
      const key = node.object.type === 'Ident' ? node.object.name + '.' + node.property : null
      if (key && MATH_CONSTANTS[key] !== undefined) return 'f64'
      if (node.object.type === 'Ident' && node.object.name === 'this') {
        const selfType = scope.get('this')
        if (selfType === undefined) throw new SyntaxError('this 只能用在 class 方法里')
        const cls = fnTypes.classes ? fnTypes.classes.get(selfType.slice(6)) : undefined
        if (!cls) throw new SyntaxError('未声明的 class: ' + selfType.slice(6))
        const field = cls.fields.find((item) => item.name === node.property)
        if (!field) throw new SyntaxError('class ' + selfType.slice(6) + ' 没有字段 ' + node.property)
        return field.type
      }
      const owner = typeOf(node.object, scope, fnTypes)
      if (owner.startsWith('class:')) {
        const cls = fnTypes.classes ? fnTypes.classes.get(owner.slice(6)) : undefined
        if (!cls) throw new SyntaxError('未声明的 class: ' + owner.slice(6))
        const field = cls.fields.find((item) => item.name === node.property)
        if (!field) throw new SyntaxError('class ' + owner.slice(6) + ' 没有字段 ' + node.property)
        return field.type
      }
      if (owner.startsWith('obj:')) {
        const fields = fnTypes.shapes.fieldsOf(owner.slice(4))
        const field = fields.find((item) => item.name === node.property)
        if (!field) throw new SyntaxError('对象没有字段 ' + node.property)
        return field.type
      }
      throw new SyntaxError('不支持的成员访问: ' + (key || node.property))
    }
    case 'Call': {
      if (node.callee.type === 'Member') {
        // 先判内置（Math.* / console / .push），否则 typeOf(Math) 会先抛错
        const builtinLabel = node.callee.object.type === 'Ident' ? node.callee.object.name + '.' + node.callee.property : '?'
        if (builtinLabel === 'console.log') return null
        if (MATH_FUNCTIONS[builtinLabel] !== undefined) return 'f64'
        if (node.callee.property === 'test' && node.callee.object.type === 'RegExp') {
          validateRegExp(node.callee.object.pattern)
          return 'bool'
        }
        if (node.callee.property === 'push') {
          const object = typeOf(node.callee.object, scope, fnTypes)
          if (object !== 'f64[]') throw new SyntaxError('.push 只支持 number 数组')
          if (typeOf(node.args[0], scope, fnTypes) !== 'f64') throw new SyntaxError('push 的元素必须是 number')
          return null
        }
        const ownerType = typeOf(node.callee.object, scope, fnTypes)
        if (ownerType.startsWith('class:')) {
          const cls = fnTypes.classes ? fnTypes.classes.get(ownerType.slice(6)) : undefined
          if (!cls) throw new SyntaxError('未声明的 class: ' + ownerType.slice(6))
          const method = cls.methods.get(node.callee.property)
          if (!method) throw new SyntaxError('class ' + ownerType.slice(6) + ' 没有方法 ' + node.callee.property)
          return method.returns
        }
        throw new SyntaxError('不支持的调用 ' + builtinLabel + '（fs/net/child_process 等 Node 内置模块无法转译）')
      }
      if (node.callee.type !== 'Ident') throw new SyntaxError('只支持直接调用具名函数')
      const sig = fnTypes.get(node.callee.name)
      if (!sig) {
        if (fnTypes.importMap && fnTypes.importMap.has(node.callee.name)) return 'f64'
        throw new SyntaxError('调用了不存在的函数: ' + node.callee.name)
      }
      if (sig.returns === null) throw new SyntaxError('函数 ' + node.callee.name + ' 没有返回值，不能用在表达式里')
      return sig.returns
    }
    default: throw new SyntaxError('未知表达式节点: ' + node.type)
  }
}

/** 收集函数体里所有 return 的表达式类型（null 表示无 return） */
function inferSignature(fn, paramTypes, fnTypes) {
  const scope = new Map()
  paramTypes.forEach((type, index) => scope.set(fn.params[index], type))
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

/** 内部类型名 -> Rust 类型名。 */
function rustType(type) {
  if (type === 'string') return 'String'
  if (type === 'f64[]') return 'Vec<f64>'
  if (type.startsWith('obj:')) return type.slice(4)
  if (type.startsWith('class:')) return type.slice(6)
  return type
}

/** 未初始化变量的默认值（JS 里是 undefined，这里取该类型的安全默认）。 */
function defaultValue(type) {
  if (type === 'string') return 'String::new()'
  if (type === 'f64[]') return 'vec![]'
  if (type === 'bool') return 'false'
  return '0.0'
}

function literal(n) {
  if (!Number.isFinite(n)) throw new SyntaxError('不支持非有限数字字面量')
  const text = String(n)
  return Number.isInteger(n) ? text + '.0' : text
}

function emitExpression(node, types) {
  switch (node.type) {
    case 'Number': return literal(node.value)
    case 'String': return JSON.stringify(node.value).replace(/^"/, 'String::from("').replace(/"$/, '")')
    case 'Template': {
      const pieces = []
      const args = []
      for (const part of node.parts) {
        if (part.kind === 'quasi') {
          // format! 里花括号要转义
          const literal = part.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}')
          pieces.push(literal)
          continue
        }
        const partType = typeOf(part.node, types.scope, types.fnTypes)
        if (partType === 'f64[]') throw new SyntaxError('数组不能直接插入模板字符串')
        pieces.push('{}')
        args.push(emitExpression(part.node, types))
      }
      return 'format!("' + pieces.join('') + '"' + (args.length ? ', ' + args.join(', ') : '') + ')'
    }
    case 'Boolean': return node.value ? 'true' : 'false'
    case 'Array': return 'vec![' + node.elements.map((element) => emitExpression(element, types)).join(', ') + ']'
    case 'Index': return '(' + emitExpression(node.object, types) + '[' + emitExpression(node.index, types) + ' as usize])'
    case 'New': return node.callee + '::new(' + node.args.map((arg) => emitExpression(arg, types)).join(', ') + ')'
    case 'Ident': {
      if (node.name === 'this') return 'self'
      const imported = types.fnTypes.importMap ? types.fnTypes.importMap.get(node.name) : undefined
      return imported ? 'crate::' + imported.module + '::' + imported.name : node.name
    }
    case 'Unary': return '(' + node.operator + emitExpression(node.argument, types) + ')'
    case 'Binary': {
      const leftType = typeOf(node.left, types.scope, types.fnTypes)
      if (node.operator === '+' && leftType === 'string') {
        return 'format!("{}{}", ' + emitExpression(node.left, types) + ', ' + emitExpression(node.right, types) + ')'
      }
      return '(' + emitExpression(node.left, types) + ' ' + node.operator + ' ' + emitExpression(node.right, types) + ')'
    }
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
      if (node.left.type === 'Member') {
        if (node.operator !== '=') throw new SyntaxError('对象字段只支持 = 赋值')
        return '(' + emitExpression(node.left, types) + ' = ' + emitExpression(node.right, types) + ')'
      }
      if (node.left.type !== 'Ident') throw new SyntaxError('只支持给变量或对象字段赋值')
      return '(' + node.left.name + ' ' + node.operator + ' ' + emitExpression(node.right, types) + ')'
    }
    case 'ObjectLiteral': {
      const objectType = typeOf(node, types.scope, types.fnTypes)
      const shape = types.fnTypes.shapes.fieldsOf(objectType.slice(4))
      const parts = []
      // 显式字段直接取值
      const explicit = new Map()
      for (const property of node.properties) {
        if (property.spread) continue
        explicit.set(property.key, emitExpression(property.value, types))
      }
      // 展开来源：按字段名从对应 base 上取
      const spreadSources = node.properties.filter((property) => property.spread)
      for (const field of shape) {
        if (explicit.has(field.name)) { parts.push(field.name + ': ' + explicit.get(field.name)); continue }
        const from = spreadSources.map((item) => '(' + emitExpression(item.value, types) + ').' + field.name)
        if (from.length === 0) { parts.push(field.name + ': ' + defaultValue(field.type)); continue }
        parts.push(field.name + ': ' + from[from.length - 1])
      }
      return objectType.slice(4) + ' { ' + parts.join(', ') + ' }'
    }
    case 'Member': {
      if (node.property === 'length') {
        const objectType = typeOf(node.object, types.scope, types.fnTypes)
        if (objectType === 'string') return '(' + emitExpression(node.object, types) + ').chars().count() as f64'
        return '(' + emitExpression(node.object, types) + ').len() as f64'
      }
      const key = node.object.type === 'Ident' ? node.object.name + '.' + node.property : null
      if (key && MATH_CONSTANTS[key] !== undefined) return '(' + MATH_CONSTANTS[key] + ')'
      const ownerType = typeOf(node.object, types.scope, types.fnTypes)
      if (ownerType.startsWith('obj:') || ownerType.startsWith('class:')) return '(' + emitExpression(node.object, types) + ').' + node.property
      throw new SyntaxError('不支持的成员访问: ' + (key || node.property))
    }
    case 'Call': {
      const args = node.args.map((arg) => emitExpression(arg, types))
      if (node.callee.type === 'Member') {
        const label = node.callee.object.type === 'Ident' ? node.callee.object.name + '.' + node.callee.property : '?'
        // 顺序很重要：先内置（Math/console/push），再 class 方法——
        // 否则 typeOf(Math) 会先抛「未声明的标识符」。
        if (label === 'console.log') throw new SyntaxError('console.log 只能作为独立语句使用')
        if (node.callee.property === 'test' && node.callee.object.type === 'RegExp') {
          validateRegExp(node.callee.object.pattern)
          const subject = args.length > 0 ? args[0] : 'String::new()'
          return 'js_regex_test(' + JSON.stringify(node.callee.object.pattern) + ', ' + JSON.stringify(node.callee.object.flags || '') + ', &(' + subject + '))'
        }
        if (node.callee.property === 'push') {
          return '(' + emitExpression(node.callee.object, types) + ').push(' + args.join(', ') + ')'
        }
        const mapper = MATH_FUNCTIONS[label]
        if (mapper) return mapper(args)
        const methodOwner = typeOf(node.callee.object, types.scope, types.fnTypes)
        if (methodOwner.startsWith('class:')) {
          return '(' + emitExpression(node.callee.object, types) + ').' + node.callee.property + '(' + args.join(', ') + ')'
        }
        throw new SyntaxError('不支持的调用: ' + label)
      }
      const imported = types.fnTypes.importMap ? types.fnTypes.importMap.get(node.callee.name) : undefined
      const target = imported ? 'crate::' + imported.module + '::' + imported.name : node.callee.name
      return target + '(' + args.join(', ') + ')'
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
        const value = statement.init ? emitExpression(statement.init, types) : defaultValue(type)
        out.push(pad + 'let mut ' + statement.name + ': ' + rustType(type) + ' = ' + value + ';')
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
/** 收集 AST 里出现过的标识符名（用于判断是否引用了 import 进来的名字）。 */
function collectIdents(node, into) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const item of node) collectIdents(item, into); return }
  if (node.type === 'Ident') into.add(node.name)
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') collectIdents(value, into)
  }
}

/**
 * 把一份源码转译成 Rust。
 * @param {string} source JS 源码。
 * @param {{ imports?: Map<string, { module: string, name: string }> }} [options]
 *   project 模式下传入的跨模块映射（local 名 -> 目标模块与导出名）。
 * @returns {{ rust: string, signatures: Array<object>, consts: Array<object> }}
 */
export function transpile(source, options = {}) {
  const { functions, pragmas, imports, exportedConsts, moduleConsts, classes } = parse(tokenize(source))
  const importMap = options.imports || null
  if (imports !== null && imports.size > 0) {
    const used = new Set()
    for (const fn of functions) collectIdents(fn.body, used)
    for (const item of [...moduleConsts, ...exportedConsts]) collectIdents(item.init, used)
    for (const local of imports.keys()) {
      if (!used.has(local)) continue
      if (importMap === null) {
        throw new SyntaxError(
          '引用了跨模块名字 ' + local + '（来自 ' + imports.get(local).source + '），' +
          '单文件模式无法解析；请用 project 模式：node bin/jsrust.mjs project <入口文件>',
        )
      }
    }
  }
  // 参数类型来源：先看 //! 类型标注（独立函数没有调用点可推断），再靠调用点迭代回填。
  const paramTypes = new Map()
  for (const fn of functions) {
    paramTypes.set(fn.name, fn.params.map((name) => {
      const declared = pragmas.get(name)
      if (declared === undefined) return 'f64'
      if (!['f64', 'bool', 'string', 'f64[]'].includes(declared)) {
        throw new SyntaxError('不支持的参数类型标注: ' + name + ':' + declared)
      }
      return declared
    }))
  }

  // 迭代推断：从调用点回填参数类型，直到稳定。
  // 先建临时签名表（返回值先假设 f64），再迭代收敛。
  // 必须这样做：递归调用在推断自身签名时就要能查到目标函数。
  const fnTypes = new Map()
  for (const fn of functions) fnTypes.set(fn.name, { params: paramTypes.get(fn.name), returns: 'f64' })

  // 对象字面量的形状注册表：同一字段序列复用同一个结构体名
  const shapeOrder = []
  const shapesByName = new Map()
  const shapesByKey = new Map()
  let shapeSeq = 0
  fnTypes.shapes = {
    register(fields) {
      const key = fields.map((field) => field.name + ':' + field.type).join(',')
      const existing = shapesByKey.get(key)
      if (existing !== undefined) return existing
      shapeSeq += 1
      const name = 'Obj_' + shapeSeq
      shapesByKey.set(key, name)
      shapesByName.set(name, fields)
      shapeOrder.push({ name, fields })
      return name
    },
    fieldsOf(name) {
      const fields = shapesByName.get(name)
      if (fields === undefined) throw new SyntaxError('未知对象形状: ' + name)
      return fields
    },
  }
  // 必须在推断之前挂上：推断阶段就会遇到跨模块调用
  if (importMap !== null) fnTypes.importMap = importMap

  // 收集所有 return 表达式的类型（class 方法返回值推断用）
  function inferReturns(body, scope) {
    const found = []
    const walk = (statements) => {
      for (const statement of statements) {
        if (statement.type === 'Return' && statement.argument) found.push(typeOf(statement.argument, scope, fnTypes))
        if (statement.type === 'If') { walk(statement.consequent); if (statement.alternate) walk(statement.alternate) }
        if (statement.type === 'While') walk(statement.body)
        if (statement.type === 'For') walk(statement.body)
        if (statement.type === 'Block') walk(statement.body)
      }
    }
    walk(body)
    const unique = [...new Set(found)]
    if (unique.length > 1) throw new SyntaxError('方法返回值类型不一致: ' + unique.join(' / '))
    return unique.length === 0 ? null : unique[0]
  }

  // class 注册表：字段来自构造器里的 this.x = ... 赋值
  const classRegistry = new Map()
  // 必须立刻挂上：构造 class 注册表时就要能回查（方法体里的 this.x）
  fnTypes.classes = classRegistry
  for (const cls of classes) {
    const ctor = cls.methods.find((method) => method.name === 'constructor')
    const fields = []
    const ctorScope = new Map()
    const ctorTypes = ctor ? ctor.params.map((name) => pragmas.get(name) || 'f64') : []
    if (ctor) ctor.params.forEach((name, index) => ctorScope.set(name, ctorTypes[index]))
    if (ctor) {
      for (const statement of ctor.body) {
        const expression = statement.type === 'Expr' ? statement.expression : null
        const ok = expression && expression.type === 'Assign' && expression.operator === '=' &&
          expression.left.type === 'Member' && expression.left.object.type === 'Ident' && expression.left.object.name === 'this'
        if (!ok) throw new SyntaxError('class ' + cls.name + '：构造器 v0 只支持 this.x = 表达式 赋值')
        const name = expression.left.property
        const type = typeOf(expression.right, ctorScope, fnTypes)
        const at = fields.findIndex((item) => item.name === name)
        if (at >= 0) {
          fields[at] = { name, type }
        } else {
          fields.push({ name, type })
        }
      }
    }
    const methods = new Map()
    // 先登记（fields/ctor 已就绪）：方法体推断时会回查自身 class
    classRegistry.set(cls.name, { name: cls.name, exported: cls.exported, fields, methods, ctor, ctorTypes })
    for (const method of cls.methods) {
      if (method.name === 'constructor') continue
      const scope = new Map()
      scope.set('this', 'class:' + cls.name)
      const types = method.params.map((name) => pragmas.get(name) || 'f64')
      method.params.forEach((name, index) => scope.set(name, types[index]))
      methods.set(method.name, { params: method.params, types, returns: inferReturns(method.body, scope), body: method.body })
    }
    classRegistry.set(cls.name, { name: cls.name, exported: cls.exported, fields, methods, ctor, ctorTypes })
  }
  fnTypes.classes = classRegistry
  let signatures = null
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    for (const fn of functions) {
      const types = paramTypes.get(fn.name)
      const entry = fnTypes.get(fn.name)
      entry.params = types
      const inferred = inferSignature(fn, types, fnTypes)
      if (entry.returns !== inferred) {
        entry.returns = inferred
      }
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
      returns: fnTypes.get(fn.name).returns,
    }))
    if (!changed) break
  }

  for (const signature of signatures) fnTypes.set(signature.name, signature)

  const out = [PRELUDE]

  // 模块级常量与导出常量：Rust 的 const 只接受常量表达式，rustc 会替我们把关。
  const consts = []
  for (const item of moduleConsts) consts.push({ ...item, exported: false })
  for (const item of exportedConsts) consts.push({ ...item, exported: true })
  for (const item of consts) {
    const scope = new Map()
    const type = typeOf(item.init, scope, fnTypes)
    if (type !== 'f64' && type !== 'bool') {
      throw new SyntaxError('顶层常量 ' + item.name + ' 目前只支持 number / boolean，实际 ' + type)
    }
    const types = { scope, fnTypes }
    out.push((item.exported ? 'pub const ' : 'const ') + item.name + ': ' + rustType(type) + ' = ' + emitExpression(item.init, types) + ';')
  }
  if (consts.length > 0) out.push('')

  // 对象字面量对应的结构体（字段类型只允许 f64/bool/String）
  for (const shape of shapeOrder) {
    out.push('#[derive(Clone, Debug)]')
    out.push('struct ' + shape.name + ' { ' + shape.fields.map((field) => field.name + ': ' + rustType(field.type)).join(', ') + ' }')
  }
  if (shapeOrder.length > 0) out.push('')

  // class：结构体 + impl（构造器 -> new，方法 -> &mut self）
  for (const cls of classRegistry.values()) {
    out.push('#[derive(Clone, Debug)]')
    out.push('struct ' + cls.name + ' { ' + cls.fields.map((field) => field.name + ': ' + rustType(field.type)).join(', ') + ' }')
    out.push('impl ' + cls.name + ' {')
    if (cls.ctor) {
      const ctorScope = new Map()
      cls.ctor.params.forEach((name, index) => ctorScope.set(name, cls.ctorTypes[index]))
      const ctorTypes = { scope: ctorScope, fnTypes }
      const params = cls.ctor.params.map((name, index) => 'mut ' + name + ': ' + rustType(cls.ctorTypes[index]))
      const inits = cls.fields.map((field) => {
        const statement = cls.ctor.body.find((item) => item.type === 'Expr' && item.expression.left && item.expression.left.property === field.name)
        return field.name + ': ' + emitExpression(statement.expression.right, ctorTypes)
      })
      out.push('    fn new(' + params.join(', ') + ') -> Self {')
      out.push('        Self { ' + inits.join(', ') + ' }')
      out.push('    }')
    }
    for (const [methodName, method] of cls.methods) {
      const scope = new Map([['this', 'class:' + cls.name]])
      method.params.forEach((name, index) => scope.set(name, method.types[index]))
      const types = { scope, fnTypes }
      const params = method.params.map((name, index) => 'mut ' + name + ': ' + rustType(method.types[index]))
      const returns = method.returns ? ' -> ' + rustType(method.returns) : ''
      out.push('    fn ' + methodName + '(&mut self' + (params.length > 0 ? ', ' + params.join(', ') : '') + ')' + returns + ' {')
      out.push(emitStatements(method.body, 2, types, 0))
      out.push('    }')
    }
    out.push('}')
    out.push('')
  }

  for (const fn of functions) {
    const signature = signatures.find((item) => item.name === fn.name)
    const scope = new Map()
    fn.params.forEach((name, index) => scope.set(name, signature.params[index]))
    const types = { scope, fnTypes }
    // 参数一律加 mut：JS 允许在函数体里给参数重新赋值（如 gcd/collatz），Rust 默认不可变。
    const params = fn.params.map((name, index) => 'mut ' + name + ': ' + rustType(signature.params[index])).join(', ')
    const returns = signature.returns ? ' -> ' + rustType(signature.returns) : ''
    out.push((fn.exported ? 'pub fn ' : 'fn ') + fn.name + '(' + params + ')' + returns + ' {')
    out.push(emitStatements(fn.body, 1, types, 0))
    out.push('}')
    out.push('')
  }
  return { rust: out.join('\n'), signatures, consts }
}
