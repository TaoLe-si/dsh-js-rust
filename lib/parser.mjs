/**
 * 词法 + 语法分析：把受支持的 JS 数值子集解析成 AST。
 *
 * 子集刻意写死：超出子集的语法一律报错，不做「猜」。一个猜得很像的转译器
 * 比没有更危险——它会静默改变语义。
 *
 * v0.1 覆盖：number(f64) / boolean、let/const、if/else、while、for、
 * 算术、比较、逻辑、三元、赋值、自增、函数声明与递归调用、return/break/continue。
 * 未覆盖（会明确报错）：字符串、数组、对象、闭包、async、try/catch、类。
 */

const KEYWORDS = new Set([
  'function', 'let', 'const', 'var', 'return', 'if', 'else', 'while', 'for',
  'break', 'continue', 'true', 'false',
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

    if (ch === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      const text = source.slice(index, end === -1 ? source.length : end)
      // //! 开头的注释是类型标注： //! types: s:string a:f64[]
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

    if (ch === '"' || ch === "'") {
      const quote = ch
      const start = index
      index += 1
      let text = ''
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          const next = source[index + 1]
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next
          index += 2
          continue
        }
        if (source[index] === '\n') throw new SyntaxError('第 ' + line + ' 行：字符串里不能直接换行')
        text += source[index]
        index += 1
      }
      if (index >= source.length) throw new SyntaxError('第 ' + line + ' 行：未闭合的字符串')
      index += 1
      tokens.push({ type: 'string', value: text, line, pos: start })
      continue
    }

    if (isIdentStart(ch)) {
      const start = index
      while (index < source.length && isIdentPart(source[index])) index += 1
      const word = source.slice(start, index)
      tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, line })
      continue
    }

    const two = source.slice(index, index + 2)
    if (['===', '!=='].includes(source.slice(index, index + 3))) {
      const op = source.slice(index, index + 3)
      tokens.push({ type: 'punct', value: op === '===' ? '==' : '!=', line })
      index += 3
      continue
    }
    if (['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%='].includes(two)) {
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

/** @param {Array<object>} tokens @returns {{ functions: Array<object> }} AST */
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
  while (peek().type !== 'eof') {
    if (peek().type === 'pragma') {
      const body = next().value.replace(/^types\s*:/i, '')
      for (const item of body.split(/[,\s]+/).filter(Boolean)) {
        const [name, type] = item.split(':')
        if (name && type) pragmas.set(name, type)
      }
      continue
    }
    if (!at('function')) fail('顶层只允许 function 声明')
    functions.push(parseFunction())
  }
  if (functions.length === 0) throw new SyntaxError('源码里没有任何 function 声明')
  return { functions, pragmas }

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
      let init = null
      if (at('=')) { next(); init = parseExpression() }
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
    if (at('{')) fail('子集 v0.1 不支持对象字面量')
    if (token.type === 'ident') { next(); return { type: 'Ident', name: token.value } }
    fail('无法解析的表达式起始 ' + JSON.stringify(token.value))
  }
}
