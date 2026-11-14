// Версия приложения: из package.json; коммит и дата сборки — из переменных, которые проставляет сборка образа
const pkg = require("../package.json");

const VERSION = pkg.version;
const COMMIT = process.env.BUILD_COMMIT || null;
const BUILT = process.env.BUILD_DATE || null;

// Сравнение версий вида 1.2.3 (суффикс -rc.1 и т. п. считается младше той же версии без суффикса)
function compare(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v).split("-");
    return { n: main.split(".").map((x) => Number(x) || 0), pre: pre || null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) < (y.n[i] || 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

module.exports = { VERSION, COMMIT, BUILT, compare };
