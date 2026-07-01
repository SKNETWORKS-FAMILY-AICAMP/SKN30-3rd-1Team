"""SessionCrypto 단위 테스트.

lazy init(모듈 import 시 env var 불필요), encrypt/decrypt round-trip,
키 길이 검증을 검증한다. 실제 DB/네트워크는 사용하지 않는다.
"""
import base64
import os

import pytest


def _b64_key(nbytes: int) -> str:
    return base64.b64encode(os.urandom(nbytes)).decode()


@pytest.fixture(autouse=True)
def _reset_session_crypto_singleton():
    """다른 테스트 모듈에서 캐시된 싱글턴이 남아있지 않도록 매 테스트 전후로 초기화한다."""
    import backend.security.session_crypto as sc
    sc._session_crypto = None
    yield
    sc._session_crypto = None


def test_import_without_session_memory_key(monkeypatch):
    """SESSION_MEMORY_KEY 없이도 모듈 import가 성공해야 한다 (lazy init 검증)."""
    monkeypatch.delenv("SESSION_MEMORY_KEY", raising=False)
    import backend.security.session_crypto as sc
    assert sc._session_crypto is None


def test_get_session_crypto_raises_without_key(monkeypatch):
    monkeypatch.delenv("SESSION_MEMORY_KEY", raising=False)
    import backend.security.session_crypto as sc
    with pytest.raises(ValueError, match="SESSION_MEMORY_KEY"):
        sc.get_session_crypto()


def test_get_session_crypto_rejects_invalid_key_length(monkeypatch):
    monkeypatch.setenv("SESSION_MEMORY_KEY", _b64_key(5))
    import backend.security.session_crypto as sc
    with pytest.raises(ValueError, match="16/24/32바이트"):
        sc.get_session_crypto()


def test_encrypt_decrypt_roundtrip(monkeypatch):
    monkeypatch.setenv("SESSION_MEMORY_KEY", _b64_key(32))
    import backend.security.session_crypto as sc
    crypto = sc.get_session_crypto()

    ciphertext, nonce, key_version = crypto.encrypt("안녕하세요, PaiM입니다.")
    assert key_version == "v1"

    plaintext = crypto.decrypt(ciphertext, nonce, key_version)
    assert plaintext == "안녕하세요, PaiM입니다."


def test_decrypt_rejects_unknown_key_version(monkeypatch):
    monkeypatch.setenv("SESSION_MEMORY_KEY", _b64_key(32))
    import backend.security.session_crypto as sc
    crypto = sc.get_session_crypto()

    ciphertext, nonce, _ = crypto.encrypt("secret")
    with pytest.raises(ValueError, match="키 버전"):
        crypto.decrypt(ciphertext, nonce, "v99")
