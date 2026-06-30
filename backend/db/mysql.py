import os
import pymysql
import pymysql.cursors
from dotenv import load_dotenv

load_dotenv()


def get_connection():
    return pymysql.connect(
        host=os.getenv("DB_HOST", "localhost"),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "paiM"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )
