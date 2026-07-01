# backend/security/session_crypto.py
import os
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

class SessionCrypto:

    # AES-128/192/256-GCM이 요구하는 키 바이트 길이
    _VALID_KEY_LENGTHS = (16, 24, 32)

    def __init__(self):
        key_env = os.getenv("SESSION_MEMORY_KEY")
        if not key_env:
            raise ValueError("환경변수 'SESSION_MEMORY_KEY'가 설정되지 않았습니다.")

        key_bytes = base64.b64decode(key_env)
        if len(key_bytes) not in self._VALID_KEY_LENGTHS:
            raise ValueError(
                "'SESSION_MEMORY_KEY'는 base64로 인코딩된 16/24/32바이트 키여야 합니다 "
                f"(현재 {len(key_bytes)}바이트)."
            )

        # 1차 구현에서는 단일 마스터 키만 사용하므로 이를 'v1' 키로 매핑하여 저장
        self.current_version = "v1"
        self.keys = {
            "v1": key_bytes
        }

    def encrypt(self, plaintext: str) -> tuple[str, str, str]:
        """ 
        평문을 암호화하여 (암호문, 논스, 사용된 키 버전)을 반환합니다.
        문서 요구사항: DB에는 ciphertext, nonce, key_version만 저장한다.
        """
        if not plaintext:
            return "", "", self.current_version
        
        # 현재 활성화된 키 버전의 키 바이트를 가져옴
        key_bytes = self.keys[self.current_version]
        aesgcm = AESGCM(key_bytes)
        
        nonce = os.urandom(12) # AES-GCM 표준 12바이트 논스
        ciphertext = aesgcm.encrypt(nonce, plaintext.encode('utf-8'), None)
        
        ciphertext_b64 = base64.b64encode(ciphertext).decode('utf-8')
        nonce_b64 = base64.b64encode(nonce).decode('utf-8')
        
        # 대화 내용 암호화 시 어떤 키 버전이 사용되었는지 함께 반환
        return ciphertext_b64, nonce_b64, self.current_version

    def decrypt(self, ciphertext_b64: str, nonce_b64: str, key_version: str) -> str:
        """ 
        DB에서 저장된 key_version에 맞는 키를 찾아 안전하게 복호화합니다.
        복호화된 데이터는 메모리에만 존재해야 합니다.
        """
        if not ciphertext_b64 or not nonce_b64:
            return ""
        
        # DB에서 읽어온 key_version이 현재 서버가 모르는 버전이면 에러 처리 (미래 확장성 대비)
        if key_version not in self.keys:
            raise ValueError(f"알 수 없거나 만료된 키 버전입니다: {key_version}")
            
        key_bytes = self.keys[key_version]
        aesgcm = AESGCM(key_bytes)
        
        ciphertext = base64.b64decode(ciphertext_b64)
        nonce = base64.b64decode(nonce_b64)
        
        decrypted_bytes = aesgcm.decrypt(nonce, ciphertext, None)
        return decrypted_bytes.decode('utf-8')

_session_crypto = None  # 첫 사용 시 SESSION_MEMORY_KEY로 초기화 (lazy — 모듈 import 시 env var 불필요)


def get_session_crypto() -> SessionCrypto:
    global _session_crypto
    if _session_crypto is None:
        _session_crypto = SessionCrypto()
    return _session_crypto