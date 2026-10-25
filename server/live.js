// Живые обновления (Server-Sent Events): клиенты получают сигнал «данные изменились» и перечитывают состояние
const clients = new Set();
// Вкладок у человека бывает несколько, но не сотни: каждое соединение держит ресурсы сервера
const MAX_PER_USER = 20;
const perUser = new Map();

function broadcast(type) {
  const msg = `event: change\ndata: ${JSON.stringify({ type, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}

function events(req, res) {
  const id = req.user.id;
  if ((perUser.get(id) || 0) >= MAX_PER_USER) return res.status(429).json({ error: "Слишком много открытых вкладок" });
  perUser.set(id, (perUser.get(id) || 0) + 1);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    const n = perUser.get(id) - 1;
    if (n > 0) perUser.set(id, n);
    else perUser.delete(id);
  });
}

module.exports = { broadcast, events };
