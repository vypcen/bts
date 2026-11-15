const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 10000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Название длиннее лимита — ошибка, а не молчаливая обрезка: пользователь должен знать, что сохранится не всё
const tooLong = (v, max, what = "Название") => (typeof v === "string" && v.trim().length > max ? `${what} длиннее ${max} символов (сейчас ${v.trim().length})` : null);
// Номер из URL: только положительное целое, иначе null
const num = (v) => (/^[1-9]\d{0,8}$/.test(String(v)) ? Number(v) : null);
const ms = (d) => (d ? d.getTime() : null);

// Ошибка с кодом и текстом для пользователя: обработчик ошибок отдаёт её как есть, а не как 500
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Понятный текст сетевой ошибки fetch вместо «fetch failed»: причина лежит в e.cause
function netError(e) {
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "Нет ответа: истекло время ожидания";
  const c = e?.cause || {};
  const host = c.hostname || c.host || "";
  const MAP = {
    ENOTFOUND: `Адрес не найден (DNS)${host ? `: ${host}` : ""}`, EAI_AGAIN: "Не удалось определить адрес (DNS недоступен)",
    ECONNREFUSED: "Соединение отклонено: на этом адресе и порту никто не принимает запросы", ECONNRESET: "Соединение сброшено получателем",
    ETIMEDOUT: "Нет ответа: истекло время ожидания соединения", EHOSTUNREACH: "Хост недоступен", ENETUNREACH: "Сеть недоступна",
    UND_ERR_CONNECT_TIMEOUT: "Нет ответа: истекло время ожидания соединения",
    CERT_HAS_EXPIRED: "Сертификат получателя просрочен", DEPTH_ZERO_SELF_SIGNED_CERT: "Самоподписанный сертификат получателя",
    SELF_SIGNED_CERT_IN_CHAIN: "Самоподписанный сертификат в цепочке", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Не удалось проверить сертификат получателя",
    ERR_TLS_CERT_ALTNAME_INVALID: "Сертификат выдан на другое имя",
  };
  if (c.code && MAP[c.code]) return MAP[c.code];
  return c.code ? `${e.message} (${c.code})` : e?.message || String(e);
}

module.exports = { wrap, str, tooLong, num, ms, netError, HttpError };
