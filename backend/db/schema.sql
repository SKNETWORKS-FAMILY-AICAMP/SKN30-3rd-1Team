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
