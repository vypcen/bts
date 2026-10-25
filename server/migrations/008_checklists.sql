-- Чек-лист — второй вид тест-кейса: вместо предусловий, шагов и ожидаемого результата — список пунктов.
-- Пункты хранятся в steps, по одному в строке
ALTER TABLE test_cases ADD COLUMN kind TEXT NOT NULL DEFAULT 'case' CHECK (kind IN ('case', 'checklist'));

-- Отметки пунктов чек-листа в прогоне: {"текст пункта": "passed" | "failed" | "blocked" | "skipped"}.
-- Ключ — текст: если пункты переставили или дописали, отметки остальных не съезжают. Итог (result) считается по ним
ALTER TABLE run_results ADD COLUMN items JSONB NOT NULL DEFAULT '{}';
