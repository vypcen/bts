const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 10000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Номер из URL: только положительное целое, иначе null
const num = (v) => (/^[1-9]\d{0,8}$/.test(String(v)) ? Number(v) : null);
const ms = (d) => (d ? d.getTime() : null);

module.exports = { wrap, str, num, ms };
