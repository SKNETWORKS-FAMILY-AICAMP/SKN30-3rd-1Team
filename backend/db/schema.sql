CREATE TABLE IF NOT EXISTS projects (
    id         INT PRIMARY KEY AUTO_INCREMENT,
    name       VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    project_id  INT NOT NULL,
    filename    VARCHAR(255),
    doc_type    VARCHAR(50),
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS memory (
    id         INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    doc_id     INT NOT NULL,
    category   VARCHAR(20),
    content    TEXT,
    reason     TEXT,
    topic      VARCHAR(100),
    owner      VARCHAR(100),
    date       DATE,
    source     VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (doc_id)     REFERENCES documents(id)
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
