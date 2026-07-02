-- v3 마이그레이션 (idempotent, MySQL 8.0 호환)
-- information_schema 조회로 컬럼 존재 여부를 확인한 뒤 ALTER 실행

DROP PROCEDURE IF EXISTS paiM_migrate_v3;

DELIMITER //

CREATE PROCEDURE paiM_migrate_v3()
BEGIN

    -- ── memory 할 일 메타데이터 확장 ────────────────────────────────
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory' AND COLUMN_NAME = 'completed_at'
    ) THEN
        ALTER TABLE memory ADD COLUMN completed_at DATETIME NULL AFTER is_user_verified;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory' AND COLUMN_NAME = 'sort_order'
    ) THEN
        ALTER TABLE memory ADD COLUMN sort_order INT NULL AFTER completed_at;
    END IF;

END //

DELIMITER ;

CALL paiM_migrate_v3();
DROP PROCEDURE IF EXISTS paiM_migrate_v3;
