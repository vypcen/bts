-- Лицензионный ключ, введённый администратором в интерфейсе (одна строка). Без строки — ключ из LICENSE_KEY или бесплатная редакция
CREATE TABLE license (
  id INT PRIMARY KEY CHECK (id = 1),
  key TEXT NOT NULL,
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
