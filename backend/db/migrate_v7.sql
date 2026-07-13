-- v7 마이그레이션 (idempotent, MySQL 8.0 호환)
-- supersede 계층 1: 번복된 결정/액션을 삭제하지 않고 "대체됨"으로 표시하기 위한 컬럼.
--   superseded_by  나를 대체한 memory 항목의 id (NULL = 최신/유효)
--   superseded_at  대체된 시각
-- 이전 row는 삭제하지 않는다. 이력은 남고, 검색·조회에서만 필터링된다(mysql_search).
-- FK self-reference는 걸지 않는다 — 대체 항목 삭제 시 제약 처리가 복잡해지므로 정합성은
-- 계층 2(적재 시 판별)에서 다룬다. 계층 1은 순수 컬럼만 추가한다.

DROP PROCEDURE IF EXISTS paiM_migrate_v7;

DELIMITER //

CREATE PROCEDURE paiM_migrate_v7()
BEGIN

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory' AND COLUMN_NAME = 'superseded_by'
    ) THEN
        ALTER TABLE memory ADD COLUMN superseded_by INT NULL AFTER completed_at;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory' AND COLUMN_NAME = 'superseded_at'
    ) THEN
        ALTER TABLE memory ADD COLUMN superseded_at DATETIME NULL AFTER superseded_by;
    END IF;

END //

DELIMITER ;

CALL paiM_migrate_v7();
DROP PROCEDURE IF EXISTS paiM_migrate_v7;
