-- v8 마이그레이션 (idempotent, MySQL 8.0 호환)
-- supersede 포인터 수명주기: superseded_by에 self-FK(ON DELETE SET NULL)를 건다.
-- 불변식: 기본 조회에서 숨겨진 decision은 항상 살아있는 decision을 가리킨다.
-- 대체(신) decision이 삭제(개별/문서/프로젝트/repo 재동기화)되면 DB가 superseded_by를
-- NULL로 되돌려 구 decision이 기본 조회에 자동 복귀한다 — 삭제 경로 앱 코드는 불변.
-- (v7이 "정합성은 계층 2에서"라며 미룬 부채의 상환. superseded_at은 이력 흔적으로 남지만
--  계층 1 필터는 superseded_by IS NULL만 보므로 복귀에 영향 없다.)

DROP PROCEDURE IF EXISTS paiM_migrate_v8;

DELIMITER //

CREATE PROCEDURE paiM_migrate_v8()
BEGIN

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory'
          AND CONSTRAINT_NAME = 'fk_memory_superseded_by' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    ) THEN
        -- FK 추가 전에 이미 dangling인 포인터를 해제해 해당 decision을 복귀시킨다.
        UPDATE memory m
        LEFT JOIN (SELECT id FROM memory) live ON live.id = m.superseded_by
        SET m.superseded_by = NULL, m.superseded_at = NULL
        WHERE m.superseded_by IS NOT NULL AND live.id IS NULL;

        ALTER TABLE memory
            ADD CONSTRAINT fk_memory_superseded_by
            FOREIGN KEY (superseded_by) REFERENCES memory(id) ON DELETE SET NULL;
    END IF;

END //

DELIMITER ;

CALL paiM_migrate_v8();
DROP PROCEDURE IF EXISTS paiM_migrate_v8;
