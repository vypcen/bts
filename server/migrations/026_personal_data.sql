-- Персональные данные (152-ФЗ): согласие при регистрации и отметка об обезличивании
ALTER TABLE users ADD COLUMN pd_consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN anonymized_at TIMESTAMPTZ;
