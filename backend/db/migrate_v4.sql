-- v4 마이그레이션 (idempotent, MySQL 8.0 호환)
-- information_schema 조회로 컬럼 존재 여부를 확인한 뒤 ALTER 실행

DROP PROCEDURE IF EXISTS paiM_migrate_v4;

DELIMITER //

CREATE PROCEDURE paiM_migrate_v4()
BEGIN

    -- ── memory 기록 날짜와 마감일 분리 ───────────────────────────────
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory' AND COLUMN_NAME = 'due_date'
    ) THEN
        ALTER TABLE memory ADD COLUMN due_date DATE NULL AFTER date;
    END IF;

END //

DELIMITER ;

CALL paiM_migrate_v4();
DROP PROCEDURE IF EXISTS paiM_migrate_v4;
