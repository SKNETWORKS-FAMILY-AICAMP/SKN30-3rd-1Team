-- v5 마이그레이션 (idempotent, MySQL 8.0 호환)
-- PR→액션 완료 제안을 위한 워터마크와 suggestion inbox 테이블.

DROP PROCEDURE IF EXISTS paiM_migrate_v5;

DELIMITER //

CREATE PROCEDURE paiM_migrate_v5()
BEGIN

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repositories' AND COLUMN_NAME = 'last_reconciled_pr'
    ) THEN
        ALTER TABLE repositories ADD COLUMN last_reconciled_pr INT NULL AFTER sync_warning;
    END IF;

    CREATE TABLE IF NOT EXISTS memory_suggestions (
        id          INT PRIMARY KEY AUTO_INCREMENT,
        project_id  INT NOT NULL,
        memory_id   INT NOT NULL,
        kind        VARCHAR(20) NOT NULL,
        evidence    JSON NOT NULL,
        rationale   TEXT NOT NULL,
        confidence  VARCHAR(10) NOT NULL,
        status      VARCHAR(10) NOT NULL DEFAULT 'pending',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (memory_id)  REFERENCES memory(id) ON DELETE CASCADE,
        INDEX idx_memory_suggestions_project_status (project_id, status),
        INDEX idx_memory_suggestions_memory_status  (memory_id, status)
    );

END //

DELIMITER ;

CALL paiM_migrate_v5();
DROP PROCEDURE IF EXISTS paiM_migrate_v5;
