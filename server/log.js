// Журнал работы сервера (не путать с журналом аудита).
// LOG_FORMAT=text (по умолчанию) — строки для человека; LOG_FORMAT=json — по строке JSON на событие
// для ELK, Loki, Graylog, Vector: {"ts","level","component","msg",...поля}.
// LOG_LEVEL=debug|info|warn|error (info по умолчанию). LOG_REQUESTS=true|false — журнал запросов
// (по умолчанию включён в json и выключен в text).
//
// Весь код сервера пишет через console.log/console.error с меткой вида «[trackers] …» — эти вызовы
// перехватываются здесь, метка становится полем component, ошибка — полями err и stack.
const util = require("util");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FORMAT = process.env.LOG_FORMAT === "json" ? "json" : "text";
const MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;
const REQUESTS = process.env.LOG_REQUESTS ? process.env.LOG_REQUESTS === "true" : FORMAT === "json";

const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const listeners = [];

function write(level, component, msg, fields = {}) {
  if (LEVELS[level] < MIN) return;
  for (const fn of listeners) fn(level, component);
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (FORMAT === "json") {
    out.write(JSON.stringify({ ts: new Date().toISOString(), level, component: component || "server", msg, ...fields }) + "\n");
    return;
  }
  const extra = Object.entries(fields)
    .filter(([k]) => k !== "stack")
    .map(([k, v]) => `${k}=${typeof v === "string" && !/\s/.test(v) ? v : JSON.stringify(v)}`)
    .join(" ");
  const line = `${component ? `[${component}] ` : ""}${msg}${extra ? ` ${extra}` : ""}`;
  out.write(line + "\n");
  if (fields.stack) out.write(fields.stack + "\n");
}

// console.error("[trackers] автосоздание:", err) → component=trackers, msg="автосоздание: <сообщение>", stack
function fromConsole(level, args) {
  let component = null;
  const parts = [];
  const fields = {};
  args.forEach((a, i) => {
    if (i === 0 && typeof a === "string") {
      const m = a.match(/^\[([\w.-]+)\]\s?(.*)$/s);
      if (m) {
        component = m[1];
        if (m[2]) parts.push(m[2]);
        return;
      }
    }
    if (a instanceof Error) {
      parts.push(a.message);
      fields.err = a.code || a.name;
      if (a.stack) fields.stack = a.stack;
    } else parts.push(typeof a === "string" ? a : util.inspect(a, { depth: 4, breakLength: Infinity }));
  });
  write(level, component, parts.join(" "), fields);
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  console.log = (...a) => fromConsole("info", a);
  console.info = (...a) => fromConsole("info", a);
  console.debug = (...a) => fromConsole("debug", a);
  console.warn = (...a) => fromConsole("warn", a);
  console.error = (...a) => fromConsole("error", a);
}

const log = {
  debug: (component, msg, fields) => write("debug", component, msg, fields),
  info: (component, msg, fields) => write("info", component, msg, fields),
  warn: (component, msg, fields) => write("warn", component, msg, fields),
  error: (component, msg, fields) => write("error", component, msg, fields),
  // подписка на записи (метрики считают ошибки по компонентам)
  onWrite: (fn) => listeners.push(fn),
  install,
  original,
  FORMAT,
  REQUESTS,
};

module.exports = log;
