/**
 * Formula custom fields: arithmetic over a task's number and money fields, by
 * name ("25 - Seats sold", "(Price * Seats sold) / 100"). Used by the server
 * (dashboard totals) and the app (showing the value). Never runs code: the
 * expression is parsed by hand and only + - * / and parentheses are allowed.
 */

export function evalFormula(expr: string, values: Record<string, number | null | undefined>): number | null {
  let s = expr.replace(/[−–]/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
  // Field names, longest first so "Seats sold" wins over "Seats".
  const names = Object.keys(values).sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (!n.trim()) continue;
    const v = values[n];
    const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (re.test(s)) {
      if (v === null || v === undefined || !Number.isFinite(v)) return null;
      s = s.replace(re, `(${v})`);
    }
  }
  if (!/^[\d\s.+\-*/()]*$/.test(s) || !s.trim()) return null;
  let i = 0;
  const peek = () => {
    while (s[i] === " ") i++;
    return s[i];
  };
  const num = (): number => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = add();
      if (peek() !== ")") throw new Error("paren");
      i++;
      return v;
    }
    if (c === "-") {
      i++;
      return -num();
    }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error("number");
    i += m[0].length;
    return Number(m[0]);
  };
  const mul = (): number => {
    let v = num();
    for (;;) {
      const c = peek();
      if (c === "*") {
        i++;
        v *= num();
      } else if (c === "/") {
        i++;
        const d = num();
        v = d === 0 ? NaN : v / d;
      } else return v;
    }
  };
  const add = (): number => {
    let v = mul();
    for (;;) {
      const c = peek();
      if (c === "+") {
        i++;
        v += mul();
      } else if (c === "-") {
        i++;
        v -= mul();
      } else return v;
    }
  };
  try {
    const v = add();
    if (peek() !== undefined) return null;
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  } catch {
    return null;
  }
}
