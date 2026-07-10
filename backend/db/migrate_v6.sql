-- v6 마이그레이션 (idempotent, MySQL 8.0 호환)
-- 다중 사용자 지원: 로그인(password_hash), 세션 소유자 격리(chat_sessions.user_id),
-- 제안 승인자 감사 추적(resolved_by), 멤버별 마지막 접속(last_seen_at).

DROP PROCEDURE IF EXISTS paiM_migrate_v6;

DELIMITER //

CREATE PROCEDURE paiM_migrate_v6()
BEGIN

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_hash'
    ) THEN
        -- NULL 허용: 마이그레이션 이전 레거시/DEV 사용자 row는 비밀번호가 없음 (로그인 불가)
        ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL AFTER name;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_sessions' AND COLUMN_NAME = 'user_id'
    ) THEN
        -- NULL 허용: 기존 세션은 소유자 불명 → 프로젝트 멤버 전원에게 보임 (레거시 취급)
        ALTER TABLE chat_sessions ADD COLUMN user_id INT NULL AFTER project_id,
            ADD CONSTRAINT fk_chat_sessions_user FOREIGN KEY (user_id) REFERENCES users(id),
            ADD INDEX idx_chat_sessions_project_user (project_id, user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memory_suggestions' AND COLUMN_NAME = 'resolved_by'
    ) THEN
        ALTER TABLE memory_suggestions ADD COLUMN resolved_by INT NULL AFTER resolved_at,
            ADD CONSTRAINT fk_memory_suggestions_resolver FOREIGN KEY (resolved_by) REFERENCES users(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_members' AND COLUMN_NAME = 'last_seen_at'
    ) THEN
        ALTER TABLE project_members ADD COLUMN last_seen_at DATETIME NULL AFTER created_at;
    END IF;

END //

DELIMITER ;

CALL paiM_migrate_v6();
DROP PROCEDURE IF EXISTS paiM_migrate_v6;
