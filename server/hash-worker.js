// Поток для bcrypt. Один хэш стоит ~0,5 с процессора: в основном потоке он останавливает обработку всех запросов,
// поэтому хэширование и проверка паролей идут здесь
const { parentPort } = require("worker_threads");
const bcrypt = require("bcryptjs");

parentPort.on("message", ({ id, op, pass, arg }) => {
  try {
    const result = op === "hash" ? bcrypt.hashSync(pass, arg) : bcrypt.compareSync(pass, arg);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
