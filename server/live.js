// Живые обновления (Server-Sent Events): клиенты получают сигнал «данные изменились» и перечитывают состояние
const clients = new Set();

function broadcast(type) {
  const msg = `event: change\ndata: ${JSON.stringify({ type, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}

function events(req, res) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

module.exports = { broadcast, events };
