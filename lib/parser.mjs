/**
 * 词法 + 语法分析：把受支持的 JS 子集解析成 AST。
 *
 * 子集刻意写死：超出子集一律报错，不猜。
 * v0.2 覆盖：number/boolean/string/数组、模板字符串（含 ${} 插值）、let/const、
 * if/else、while、for、函数声明（含 export）、递归、return/break/continue。
 * 正则字面量只做词法识别，语义层明确报错。
 */

const BT = String.fromCharCode(96)

const KEYWORDS = new Set([
  'function', 'let', 'const', 'var', 'return', 'if', 'else', 'while', 'for',
  'break', 'continue', 'true', 'false', 'export', 'import', 'from', 'as',
])

/** @param {string} source @returns {Array<object>} token 列表 */
export function tokenize(source) {
  const tokens = []
  let index = 0
  let line = 1
  const isDigit = (ch) => ch >= '0' && ch <= '9'
  const isIdentStart = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$'
  const isIdentPart = (ch) => isIdentStart(ch) || isDigit(ch)

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\n') { line += 1; index += 1; continue }
    if (ch === ' ' || ch === '\t' || ch === '\r') { index += 1; continue }

    // 行注释：//! 是类型标注
    if (ch === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      const text = source.slice(index, end === -1 ? source.length : end)
      if (text.startsWith('//!')) tokens.push({ type: 'pragma', value: text.slice(3).trim(), line })
      index = end === -1 ? source.length : end
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) throw new SyntaxError('未闭合的块注释')
      const chunk = source.slice(index, end)
      for (const piece of chunk) if (piece === '\n') line += 1
      index = end + 2
      continue
    }

    // 模板字符串
    if (ch === BT) {
      const startLine = line
      index += 1
      const quasis = []
      const expressions = []
      let current = ''
      while (index < source.length && source[index] !== BT) {
        if (source[index] === '\\') {
          const next = source[index + 1]
          current += next === 'n' ? '\n' : next === 't' ? '\t' : next
          index += 2
          continue
        }
        if (source[index] === '$' && source[index + 1] === '{') {
          quasis.push(current)
          current = ''
          index += 2
          let depth = 1
          let expression = ''
          while (index < source.length && depth > 0) {
            const c = source[index]
            if (c === '{') depth += 1
            else if (c === '}') { depth -= 1; if (depth === 0) break }
            if (c === '\n') line += 1
            expression += c
            index += 1
          }
          if (depth !== 0) throw new SyntaxError('第 ' + startLine + ' 行：模板字符串插值未闭合')
          expressions.push(expression)
          index += 1
          continue
        }
        if (source[index] === '\n') line += 1
        current += source[index]
        index += 1
      }
      if (index >= source.length) throw new SyntaxError('第 ' + startLine + ' 行：未闭合的模板字符串')
      index += 1
      quasis.push(current)
      tokens.push({ type: 'template', quasis, expressions, line: startLine })
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      index += 1
      let text = ''
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          const next = source[index + 1]
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next
          index += 2
          continue
        }
        if (source[index] === '\n') throw new SyntaxError('第 ' + startLine + ' 行：字符串里不能直接换行')
        text += source[index]
        index += 1
      }
      if (index >= source.length) throw new SyntaxError('第 ' + startLine + ' 行：未闭合的字符串')
      index += 1
      tokens.push({ type: 'string', value: text, line: startLine })
      continue
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[index + 1]))) {
      const start = index
      while (index < source.length && (isDigit(source[index]) || source[index] === '.')) index += 1
      if (index < source.length && (source[index] === 'e' || source[index] === 'E')) {
        index += 1
        if (source[index] === '+' || source[index] === '-') index += 1
        while (index < source.length && isDigit(source[index])) index += 1
      }
      tokens.push({ type: 'number', value: Number(source.slice(start, index)), line })
      continue
    }

    if (isIdentStart(ch)) {
      const start = index
      while (index < source.length && isIdentPart(source[index])) index += 1
      const word = source.slice(start, index)
      tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, line })
      continue
    }

    // 正则字面量：只在「表达式起始位置」把 / 当正则，避免和除法混淆
    if (ch === '/') {
      const previous = tokens[tokens.length - 1]
      const atExpressionStart = previous === undefined ||
        (previous.type === 'punct' && previous.value !== ')' && previous.value !== ']') ||
        (previous.type === 'keyword' && previous.value !== 'true' && previous.value !== 'false')
      if (atExpressionStart) {
        const startLine = line
        index += 1
        let inClass = false
        while (index < source.length) {
          const c = source[index]
          if (c === '\\') { index += 2; continue }
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) break
          else if (c === '\n') throw new SyntaxError('第 ' + startLine + ' 行：正则字面量未闭合')
          index += 1
        }
        index += 1
        while (index < source.length && /[a-z]/i.test(source[index])) index += 1
        tokens.push({ type: 'regex', value: null, line: startLine })
        continue
      }
    }

    if (['===', '!=='].includes(source.slice(index, index + 3))) {
      const op = source.slice(index, index + 3)
      tokens.push({ type: 'punct', value: op === '===' ? '==' : '!=', line })
      index += 3
      continue
    }
    const two = source.slice(index, index + 2)
    if (['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '=>'].includes(two)) {
      tokens.push({ type: 'punct', value: two, line })
      index += 2
      continue
    }
    if ('+-*/%<>=!?:;,.(){}[]'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, line })
      index += 1
      continue
    }
    throw new SyntaxError('第 ' + line + ' 行：子集外的字符 ' + JSON.stringify(ch))
  }
  tokens.push({ type: 'eof', value: null, line })
  return tokens
}
/** @param {Array<object>} tokens @returns {{ functions: Array<object>, pragmas: Map<string,string> }} AST */
export function parse(tokens) {
  let cursor = 0
  const peek = (offset) => tokens[cursor + (offset || 0)]
  const next = () => tokens[cursor++]
  const at = (value) => peek().value === value && peek().type !== 'eof'
  const fail = (message) => { throw new SyntaxError('第 ' + peek().line + ' 行：' + message) }
  const expect = (value) => { if (!at(value)) fail('期望 ' + JSON.stringify(value) + '，实际 ' + JSON.stringify(peek().value)); return next() }
  const expectIdent = () => { if (peek().type !== 'ident') fail('期望标识符，实际 ' + JSON.stringify(peek().value)); return next().value }

  const functions = []
  const pragmas = new Map()
  /** local 名 -> { source, imported } */
  let imports = null
  const exportedConsts = []
  const exportedNames = []
  const moduleConsts = []
  while (peek().type !== 'eof') {
    if (peek().type === 'pragma') {
      const body = next().value.replace(/^types\s*:/i, '')
      for (const item of body.split(/[,\s]+/).filter(Boolean)) {
        const [name, type] = item.split(':')
        if (name && type) pragmas.set(name, type)
      }
      continue
    }
    // import { a as b } from './x.js';  /  import d from './x.js';  /  import * as ns from './x.js';  /  import './x.js';
    if (at('import')) {
      next()
      if (peek().type === 'string') { next(); expect(';'); continue }
      const bindings = []
      if (at('{')) {
        next()
        while (!at('}')) {
          const imported = expectIdent()
          let local = imported
          if (at('as')) { next(); local = expectIdent() }
          bindings.push({ imported, local })
          if (at(',')) next()
        }
        expect('}')
      } else if (at('*')) {
        next()
        if (!at('as')) fail('import * 需要 as')
        next()
        bindings.push({ imported: '*', local: expectIdent() })
      } else {
        bindings.push({ imported: 'default', local: expectIdent() })
      }
      if (!at('from')) fail('import 缺少 from')
      next()
      if (peek().type !== 'string') fail('import 来源必须是字符串字面量')
      const specifier = next().value
      expect(';')
      if (imports === null) imports = new Map()
      for (const binding of bindings) imports.set(binding.local, { source: specifier, imported: binding.imported })
      continue
    }

    if (at('export')) {
      next()
      if (at('function')) {
        const fn = parseFunction()
        fn.exported = true
        functions.push(fn)
        continue
      }
      if (at('const') || at('let')) {
        next()
        const name = expectIdent()
        expect('=')
        const init = parseExpression()
        expect(';')
        exportedConsts.push({ name, init })
        continue
      }
      if (at('{')) {
        next()
        while (!at('}')) {
          const local = expectIdent()
          let exported = local
          if (at('as')) { next(); exported = expectIdent() }
          exportedNames.push({ local, exported })
          if (at(',')) next()
        }
        expect('}')
        expect(';')
        continue
      }
      fail('export 目前支持 function / const / { } 三种形式')
    }

    // 模块级常量（非导出）
    if (at('const') || at('let') || at('var')) {
      next()
      const name = expectIdent()
      expect('=')
      const init = parseExpression()
      expect(';')
      moduleConsts.push({ name, init })
      continue
    }

    if (!at('function')) fail('顶层只允许 import / const / function 声明')
    functions.push(parseFunction())
  }
  if (functions.length === 0 && moduleConsts.length === 0 && exportedConsts.length === 0) {
    throw new SyntaxError('模块里没有任何可转译的声明')
  }
  return { functions, pragmas, imports, exportedConsts, exportedNames, moduleConsts }

  function parseFunction() {
    expect('function')
    const name = expectIdent()
    expect('(')
    const params = []
    if (!at(')')) { do { params.push(expectIdent()) } while (at(',') && next()) }
    expect(')')
    return { type: 'Function', name, params, body: parseBlock() }
  }

  function parseBlock() {
    expect('{')
    const body = []
    while (!at('}')) {
      if (peek().type === 'eof') fail('未闭合的代码块')
      body.push(parseStatement())
    }
    expect('}')
    return body
  }

  function parseStatement() {
    if (at('let') || at('const') || at('var')) {
      next()
      const name = expectIdent()
      const init = at('=') ? (next(), parseExpression()) : null
      expect(';')
      return { type: 'Var', name, init }
    }
    if (at('return')) {
      next()
      const argument = at(';') ? null : parseExpression()
      expect(';')
      return { type: 'Return', argument }
    }
    if (at('if')) {
      next(); expect('(')
      const test = parseExpression()
      expect(')')
      const consequent = at('{') ? parseBlock() : [parseStatement()]
      let alternate = null
      if (at('else')) { next(); alternate = at('{') ? parseBlock() : [parseStatement()] }
      return { type: 'If', test, consequent, alternate }
    }
    if (at('while')) {
      next(); expect('(')
      const test = parseExpression()
      expect(')')
      return { type: 'While', test, body: at('{') ? parseBlock() : [parseStatement()] }
    }
    if (at('for')) {
      next(); expect('(')
      let init = null
      if (!at(';')) {
        if (at('let') || at('const') || at('var')) {
          next()
          const name = expectIdent()
          const value = at('=') ? (next(), parseExpression()) : null
          init = { type: 'Var', name, init: value }
        } else init = parseExpression()
      }
      expect(';')
      const test = at(';') ? null : parseExpression()
      expect(';')
      const update = at(')') ? null : parseExpression()
      expect(')')
      return { type: 'For', init, test, update, body: at('{') ? parseBlock() : [parseStatement()] }
    }
    if (at('break')) { next(); expect(';'); return { type: 'Break' } }
    if (at('continue')) { next(); expect(';'); return { type: 'Continue' } }
    if (at('{')) return { type: 'Block', body: parseBlock() }
    const expression = parseExpression()
    expect(';')
    return { type: 'Expr', expression }
  }

  function parseExpression() { return parseAssignment() }

  function parseAssignment() {
    const left = parseConditional()
    const ops = ['=', '+=', '-=', '*=', '/=', '%=']
    if (peek().type === 'punct' && ops.includes(peek().value)) {
      const operator = next().value
      return { type: 'Assign', operator, left, right: parseAssignment() }
    }
    return left
  }

  function parseConditional() {
    const test = parseLogicalOr()
    if (!at('?')) return test
    next()
    const consequent = parseAssignment()
    expect(':')
    return { type: 'Conditional', test, consequent, alternate: parseAssignment() }
  }

  function parseLogicalOr() {
    let left = parseLogicalAnd()
    while (at('||')) { next(); left = { type: 'Logical', operator: '||', left, right: parseLogicalAnd() } }
    return left
  }

  function parseLogicalAnd() {
    let left = parseEquality()
    while (at('&&')) { next(); left = { type: 'Logical', operator: '&&', left, right: parseEquality() } }
    return left
  }

  function parseEquality() {
    let left = parseRelational()
    while (at('==') || at('!=')) {
      const operator = next().value
      left = { type: 'Binary', operator, left, right: parseRelational() }
    }
    return left
  }

  function parseRelational() {
    let left = parseAdditive()
    while (at('<') || at('<=') || at('>') || at('>=')) {
      const operator = next().value
      left = { type: 'Binary', operator, left, right: parseAdditive() }
    }
    return left
  }

  function parseAdditive() {
    let left = parseMultiplicative()
    while (at('+') || at('-')) {
      const operator = next().value
      left = { type: 'Binary', operator, left, right: parseMultiplicative() }
    }
    return left
  }

  function parseMultiplicative() {
    let left = parseUnary()
    while (at('*') || at('/') || at('%')) {
      const operator = next().value
      left = { type: 'Binary', operator, left, right: parseUnary() }
    }
    return left
  }

  function parseUnary() {
    if (at('-') || at('+') || at('!')) {
      const operator = next().value
      return { type: 'Unary', operator, argument: parseUnary() }
    }
    if (at('++') || at('--')) {
      const operator = next().value
      return { type: 'Update', operator, argument: parseUnary() }
    }
    return parsePostfix()
  }

  function parsePostfix() {
    let expression = parsePrimary()
    for (;;) {
      if (at('(')) {
        next()
        const args = []
        if (!at(')')) { do { args.push(parseAssignment()) } while (at(',') && next()) }
        expect(')')
        expression = { type: 'Call', callee: expression, args }
        continue
      }
      if (at('[')) {
        next()
        const index = parseExpression()
        expect(']')
        expression = { type: 'Index', object: expression, index }
        continue
      }
      if (at('.')) {
        next()
        const property = expectIdent()
        expression = { type: 'Member', object: expression, property }
        continue
      }
      if (at('++') || at('--')) {
        const operator = next().value
        expression = { type: 'Update', operator, argument: expression }
        continue
      }
      return expression
    }
  }

  function parsePrimary() {
    const token = peek()
    if (token.type === 'number') { next(); return { type: 'Number', value: token.value } }
    if (token.type === 'string') { next(); return { type: 'String', value: token.value } }
    if (token.type === 'template') {
      next()
      // 插值表达式用「包进一个函数再解析」的方式复用现有解析器，避免第二套实现
      const parts = []
      for (let i = 0; i < token.quasis.length; i += 1) {
        parts.push({ kind: 'quasi', value: token.quasis[i] })
        if (i < token.expressions.length) parts.push({ kind: 'expression', node: parseEmbedded(token.expressions[i]) })
      }
      return { type: 'Template', parts }
    }
    if (token.type === 'regex') fail('正则字面量不在子集内')
    if (at('true')) { next(); return { type: 'Boolean', value: true } }
    if (at('false')) { next(); return { type: 'Boolean', value: false } }
    if (at('(')) { next(); const inner = parseExpression(); expect(')'); return inner }
    if (at('[')) {
      next()
      const elements = []
      if (!at(']')) { do { elements.push(parseAssignment()) } while (at(',') && next()) }
      expect(']')
      return { type: 'Array', elements }
    }
    if (at('{')) fail('对象字面量不在子集内')
    if (token.type === 'ident') { next(); return { type: 'Ident', name: token.value } }
    fail('无法解析的表达式起始 ' + JSON.stringify(token.value))
  }

  /** 把一段表达式源码单独解析出来（模板字符串插值用）。 */
  function parseEmbedded(source) {
    const wrapped = 'function __tpl() { return (' + source + '); }'
    const ast = parse(tokenize(wrapped))
    return ast.functions[0].body[0].argument
  }
}
