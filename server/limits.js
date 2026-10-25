// Ограничение частоты: не больше max событий за window мс на ключ (IP, логин, пользователь).
// Память ограничена: при переполнении забываются самые старые ключи — это ослабляет лимит, но не роняет сервер
const MAX_KEYS = 50000;

class Limiter {
  constructor(max, windowMs) {
    this.max = max;
    this.window = windowMs;
    this.hits = new Map(); // key → {count, first}; Map хранит порядок вставки — первые ключи самые старые
    setInterval(() => this.sweep(), Math.min(windowMs, 10 * 60 * 1000)).unref();
  }

  entry(key) {
    const a = this.hits.get(key);
    if (a && Date.now() - a.first < this.window) return a;
    if (a) this.hits.delete(key);
    return null;
  }

  // Лимит уже исчерпан? Сама проверка событие не считает
  blocked(key) {
    const a = this.entry(key);
    return Boolean(a && a.count >= this.max);
  }

  hit(key) {
    const a = this.entry(key);
    if (a) return void a.count++;
    if (this.hits.size >= MAX_KEYS) this.hits.delete(this.hits.keys().next().value);
    this.hits.set(key, { count: 1, first: Date.now() });
  }

  // Посчитать событие и сказать, вышло ли за лимит
  take(key) {
    if (this.blocked(key)) return false;
    this.hit(key);
    return true;
  }

  clear(key) {
    this.hits.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [k, a] of this.hits) if (now - a.first >= this.window) this.hits.delete(k);
  }
}

const MIN = 60 * 1000;
module.exports = { Limiter, MIN };
