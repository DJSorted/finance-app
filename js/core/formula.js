// Safe formula engine: numbers, line codes, + - * / and brackets. Codes are case-insensitive.
// Division by zero gives 0 so a report never breaks on an empty period.

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const txt = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(txt)) throw new Error(`Invalid number "${txt}"`);
      out.push({ t: 'num', v: Number(txt) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'ref', v: src.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

export function parse(src) {
  const toks = tokenize(String(src || ''));
  if (!toks.length) throw new Error('Formula is empty');
  let p = 0;
  const eat = (v) => { const t = toks[p]; if (t && t.t === 'op' && t.v === v) { p++; return true; } return false; };

  function expr() {
    let n = term();
    for (;;) {
      if (eat('+')) n = { op: '+', a: n, b: term() };
      else if (eat('-')) n = { op: '-', a: n, b: term() };
      else return n;
    }
  }
  function term() {
    let n = unary();
    for (;;) {
      if (eat('*')) n = { op: '*', a: n, b: unary() };
      else if (eat('/')) n = { op: '/', a: n, b: unary() };
      else return n;
    }
  }
  function unary() {
    if (eat('-')) return { op: 'neg', a: unary() };
    if (eat('+')) return unary();
    return atom();
  }
  function atom() {
    const t = toks[p];
    if (!t) throw new Error('Formula ends unexpectedly');
    if (t.t === 'num') { p++; return { num: t.v }; }
    if (t.t === 'ref') { p++; return { ref: t.v }; }
    if (eat('(')) {
      const n = expr();
      if (!eat(')')) throw new Error('Missing closing bracket');
      return n;
    }
    throw new Error(`Unexpected "${t.v}"`);
  }

  const ast = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  return ast;
}

export function refsOf(ast, set = new Set()) {
  if (ast.ref) set.add(ast.ref);
  if (ast.a) refsOf(ast.a, set);
  if (ast.b) refsOf(ast.b, set);
  return set;
}

export function evaluate(ast, values) {
  if (ast.num !== undefined) return ast.num;
  if (ast.ref) {
    if (!(ast.ref in values)) throw new Error(`"${ast.ref}" is not a line above this one`);
    return values[ast.ref];
  }
  const a = evaluate(ast.a, values);
  if (ast.op === 'neg') return -a;
  const b = evaluate(ast.b, values);
  switch (ast.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? 0 : a / b;
    default: throw new Error('Bad formula');
  }
}