-- Отметки «выполнено» прямо в чек-листе, без прогона: {"текст пункта": {"by": "логин", "at": "время"}}.
-- Прогоны по-прежнему хранят свои отметки в run_results.items — это проверка конкретной сборки
ALTER TABLE test_cases ADD COLUMN checked JSONB NOT NULL DEFAULT '{}';
