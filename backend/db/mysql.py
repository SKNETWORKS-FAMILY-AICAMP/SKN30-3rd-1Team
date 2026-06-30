import os
import pymysql
import pymysql.cursors
from dotenv import load_dotenv

load_dotenv()


def get_connection():
    return pymysql.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "3306")),  # 로컬 SSH 터널(예: 3307) 대응. 미설정 시 기본 3306
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "paiM"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )
