CREATE TABLE IF NOT EXISTS users (
    id         INT PRIMARY KEY AUTO_INCREMENT,
    email      VARCHAR(255) NOT NULL UNIQUE,
    name       VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
    id             INT PRIMARY KEY AUTO_INCREMENT,
    name           VARCHAR(255),
    owner_user_id  INT NULL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id INT NOT NULL,
    user_id    INT NOT NULL,
    role       VARCHAR(20) NOT NULL DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (user_id)    REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS documents (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    project_id  INT NOT NULL,
    filename    VARCHAR(255),
    doc_type    VARCHAR(50),
    status      VARCHAR(20)  NOT NULL DEFAULT 'uploaded',
    file_path   VARCHAR(500),
    last_error  TEXT         DEFAULT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS repositories (
    id             INT PRIMARY KEY AUTO_INCREMENT,
    project_id     INT NOT NULL,
    provider       VARCHAR(20)  NOT NULL DEFAULT 'github',
    repository_url VARCHAR(500) NOT NULL,
    branch         VARCHAR(100),
    status         VARCHAR(20)  NOT NULL DEFAULT 'connected',
    commit_sha     VARCHAR(40),
    indexed_files  INT          NOT NULL DEFAULT 0,
    last_error     TEXT         DEFAULT NULL,
    sync_warning   TEXT         DEFAULT NULL,
    connected_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS memory (
    id               INT PRIMARY KEY AUTO_INCREMENT,
    project_id       INT NOT NULL,
    doc_id           INT NULL,
    repo_id          INT NULL,
    category         VARCHAR(20),
    content          TEXT,
    reason           TEXT,
    topic            VARCHAR(100),
    owner            VARCHAR(100),
    date             DATE,
    source           VARCHAR(255),
    created_by       VARCHAR(10)  NOT NULL DEFAULT 'llm',
    updated_by       VARCHAR(10)  NULL,
    is_user_verified TINYINT(1)   NOT NULL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (doc_id)     REFERENCES documents(id),
    FOREIGN KEY (repo_id)    REFERENCES repositories(id)
);

CREATE TABLE IF NOT EXISTS memory_sources (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    memory_id   INT NOT NULL,
    source_kind VARCHAR(20)  NOT NULL,
    doc_id      INT NULL,
    repo_id     INT NULL,
    source_type VARCHAR(30)  NULL,
    source_path VARCHAR(500) NULL,
    source_ref  VARCHAR(100) NULL,
    source_url  VARCHAR(500) NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (memory_id) REFERENCES memory(id) ON DELETE CASCADE,
    FOREIGN KEY (doc_id)    REFERENCES documents(id) ON DELETE SET NULL,
    FOREIGN KEY (repo_id)   REFERENCES repositories(id) ON DELETE SET NULL,
    INDEX idx_memory_sources_memory_id (memory_id),
    INDEX idx_memory_sources_doc_id    (doc_id),
    INDEX idx_memory_sources_repo_id   (repo_id)
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id         VARCHAR(64) PRIMARY KEY,
    project_id INT NOT NULL,
    title      VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    session_id  VARCHAR(64) NOT NULL,
    role        VARCHAR(20) NOT NULL,
    ciphertext  TEXT NOT NULL,
    nonce       VARCHAR(64) NOT NULL,
    key_version VARCHAR(20) NOT NULL,
    token_count INT NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);

CREATE TABLE IF NOT EXISTS chat_summaries (
    session_id         VARCHAR(64) PRIMARY KEY,
    ciphertext         TEXT NOT NULL,
    nonce              VARCHAR(64) NOT NULL,
    key_version        VARCHAR(20) NOT NULL,
    source_message_id  INT NOT NULL DEFAULT 0,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);
