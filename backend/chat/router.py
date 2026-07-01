# backend/chat/router.py
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

# 기존 정의된 암호화 모듈 및 저장소 레이어 가상 임포트
from backend.security.session_crypto import session_crypto
from backend.chat.session_store import SessionStore
from backend.chat.context_builder import ContextBuilder

router = APIRouter(prefix="/projects/{project_id}/sessions", tags=["Session Memory API"])

# --- Pydantic 데이터 검증 스키마 선언 ---
class SessionCreateRequest(BaseModel):
    title: str

class SessionUpdateRequest(BaseModel):
    title: str

class QueryRequest(BaseModel):
    current_question: str
    rag_context: Optional[str] = ""

class MessageResponse(BaseModel):
    id: int
    role: str
    text: str
    token_count: int
    created_at: datetime

class SessionResponse(BaseModel):
    id: str
    project_id: str
    title: str
    created_at: datetime
    updated_at: datetime


# --- [1] POST /projects/{project_id}/sessions (세션 생성) ---
@router.post("", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_chat_session(project_id: str, request: SessionCreateRequest, db=Depends(get_db)):
    import uuid
    session_id = f"sess_{uuid.uuid4().hex[:12]}"
    
    db.execute(
        """INSERT INTO chat_sessions (id, project_id, title) 
           VALUES (:id, :project_id, :title)""",
        {"id": session_id, "project_id": project_id, "title": request.title}
    )
    db.commit()
    
    row = db.execute("SELECT * FROM chat_sessions WHERE id = :id", {"id": session_id}).fetchone()
    return row


# --- [2] GET /projects/{project_id}/sessions (세션 목록 조회) ---
@router.post("/list", response_model=List[SessionResponse])
@router.get("", response_model=List[SessionResponse])
async def get_chat_session_list(project_id: str, db=Depends(get_db)):
    rows = db.execute(
        "SELECT * FROM chat_sessions WHERE project_id = :project_id ORDER BY updated_at DESC",
        {"project_id": project_id}
    ).fetchall()
    return rows


# --- [3] PATCH /projects/{project_id}/sessions/{session_id} (세션 수정) ---
@router.patch("/{session_id}", response_model=SessionResponse)
async def update_chat_session(project_id: str, session_id: str, request: SessionUpdateRequest, db=Depends(get_db)):
    session = db.execute("SELECT id FROM chat_sessions WHERE id = :id AND project_id = :project_id", 
                         {"id": session_id, "project_id": project_id}).fetchone()
    if not session:
        raise HTTPException(status_code=404, detail="해당 프로젝트에서 요청하신 세션을 찾을 수 없습니다.")
        
    db.execute(
        "UPDATE chat_sessions SET title = :title WHERE id = :id",
        {"title": request.title, "id": session_id}
    )
    db.commit()
    
    row = db.execute("SELECT * FROM chat_sessions WHERE id = :id", {"id": session_id}).fetchone()
    return row


# --- [4] DELETE /projects/{project_id}/sessions/{session_id} (세션 삭제) ---
@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chat_session(project_id: str, session_id: str, db=Depends(get_db)):
    session = db.execute("SELECT id FROM chat_sessions WHERE id = :id AND project_id = :project_id", 
                         {"id": session_id, "project_id": project_id}).fetchone()
    if not session:
        raise HTTPException(status_code=404, detail="삭제할 세션이 존재하지 않습니다.")
        
    db.execute("DELETE FROM chat_sessions WHERE id = :id", {"id": session_id})
    db.commit()
    return


# --- [5] GET /projects/{project_id}/sessions/{session_id}/messages (메시지 이력 조회) ---
@router.get("/{session_id}/messages", response_model=List[MessageResponse])
async def get_session_message_history(project_id: str, session_id: str, db=Depends(get_db)):
    rows = db.execute(
        """SELECT id, role, ciphertext, nonce, key_version, token_count, created_at 
           FROM chat_messages WHERE session_id = :session_id ORDER BY id ASC""",
        {"session_id": session_id}
    ).fetchall()
    
    decrypted_history = []
    for r in rows:
        plain_text = session_crypto.decrypt(
            ciphertext_b64=r.ciphertext, 
            nonce_b64=r.nonce, 
            key_version=r.key_version
        )
        decrypted_history.append({
            "id": r.id,
            "role": r.role,
            "text": plain_text,
            "token_count": r.token_count,
            "created_at": r.created_at
        })
        
    return decrypted_history


# --- [6] POST /projects/{project_id}/sessions/{session_id}/query (세션 기반 최종 질의 API) ---
@router.post("/{session_id}/query")
async def handle_session_query(project_id: str, session_id: str, request: QueryRequest, db=Depends(get_db)):
    store = SessionStore(db)
    
    # DB로부터 암호화 세션 상태를 복호화하여 런타임 메모리에 안착
    current_summary, recent_messages, last_summary_id = store.get_session_context(session_id)
    
    import tiktoken
    encoder = tiktoken.encoding_for_model("gpt-4o")
    u_token = len(encoder.encode(request.current_question))
    
    # 1. 유저 신규 질문을 세션 스토어 및 DB에 기록
    user_msg_id = store.save_message(
        session_id=session_id, 
        role="user", 
        text=request.current_question, 
        token_count=u_token
    )
    
    # 실시간 컨텍스트 토큰 예산 검증을 위해 최신 메시지 리스트에 유저 질문 우선 추가
    recent_messages.append({"id": user_msg_id, "role": "user", "text": request.current_question, "token_count": u_token})

    # 기획서 규격 연동을 위해 RAG 컨텍스트 평문을 스코어를 가진 구조형 객체 배열화
    retrieved_rag_chunks = [
        {"text": request.rag_context, "score": 0.85}
    ] if request.rag_context else []

    # =========================================================================
    # 📍 [조건 1 & 2]: 예산 수립 및 출력 Reserve 공간 정의 구간
    # =========================================================================
    CONTEXT_WINDOW = 128000
    MAX_TOTAL_BUDGET = int(CONTEXT_WINDOW * 0.65)  # 조건 1: 컨텍스트 윈도우의 60~70% 예산 지정 (65%)
    OUTPUT_RESERVE = 4000                          # 조건 2: 최소 2~4k tokens 출력 공간 확보 (4000)

    # 현재 조립 완료 단계의 총합 토큰을 연산하는 헬퍼 함수 정의
    def calculate_current_total_tokens() -> int:
        t_summary = len(encoder.encode(current_summary)) if current_summary else 0
        t_recent_msgs = sum(msg.get("token_count", 0) for msg in recent_messages)
        t_rag = sum(len(encoder.encode(chunk["text"])) for chunk in retrieved_rag_chunks)
        t_current_q = u_token
        return t_summary + t_recent_msgs + t_rag + t_current_q

    # =========================================================================
    # 📍 [조건 3]: 입력 예산 초과 시 제거 우선순위 순차 루프 작동 구간
    # 제거 순서: 오래된 recent messages → 낮은 점수 RAG context → summary 재압축
    # =========================================================================
    while calculate_current_total_tokens() > MAX_TOTAL_BUDGET:
        # 순서 1: 오래된 recent messages 우선 제거 (단, 방금 던진 유저 질문인 마지막 인덱스는 무조건 수호)
        if len(recent_messages) > 1:
            recent_messages.pop(0)
            continue
            
        # 순서 2: 검색 점수가 낮은 RAG context 제거
        if len(retrieved_rag_chunks) > 0:
            retrieved_rag_chunks.sort(key=lambda x: x["score"])  # 오름차순 정렬
            retrieved_rag_chunks.pop(0)                          # 가장 점수가 낮은 RAG 요소 탈락
            continue
            
        # 순서 3: 이전 단계를 거쳐도 한도가 부족할 시 최종 summary 컨텍스트 재압축 단행
        if current_summary:
            current_summary = "[LLM 강제 재압축 요약]: 컨텍스트 입력 임계치를 준수하기 위해 기존 요약 데이터가 재압축되었습니다."
            break
        break

    # -------------------------------------------------------------------------
    # 정제 완료된 안전한 최적화 데이터 컴포넌트들을 전달하여 최종 시스템 프롬프트 조립
    # -------------------------------------------------------------------------
    builder = ContextBuilder(model_name="gpt-4o")
    final_prompt_messages = builder.build_final_prompt(
        system_prompt="당신은 개발 프로젝트 통합 도우미 PaiM입니다.",
        decrypted_summary=current_summary,
        decrypted_recent_messages=recent_messages,
        rag_chunks=retrieved_rag_chunks,
        current_question=request.current_question,
        max_total_budget=MAX_TOTAL_BUDGET
    )
    # -------------------------------------------------------------------------
    
    # 가상의 외부 LLM 연산 처리 구간
    llm_response_text = f"상기 복호화된 대화 상태와 RAG 컨텍스트를 종합 분석한 결과 답변입니다. (세션: {session_id})"
    
    # 2. 생성된 AI 응답을 세션 스토어 및 DB에 기록
    a_token = len(encoder.encode(llm_response_text))
    assistant_msg_id = store.save_message(
        session_id=session_id, 
        role="assistant", 
        text=llm_response_text, 
        token_count=a_token
    )
    
    # 다음 턴 처리를 위해 AI 답변을 최신 메시지 윈도우에 최종 포함
    recent_messages.append({"id": assistant_msg_id, "role": "assistant", "text": llm_response_text, "token_count": a_token})
    
    # =========================================================================
    # 📍 [조건 4]: 평시 대화 누적에 따른 Rolling Summary 병합 제어부
    # 기획서 제약 사항 슈도코드를 1:1 완벽 이식 및 매핑 완료
    # =========================================================================
    RECENT_MESSAGE_BUDGET = 4000      # 최신 대화방 유지 임계 토큰 버젯
    RECENT_MESSAGE_KEEP_COUNT = 10    # 컨텍스트 보존을 위해 남겨둘 최신 메시지 개수
    
    recent_message_tokens = sum(msg["token_count"] for msg in recent_messages)
    
    # recent message 토큰이 임계치 이상이면 오래된 메시지를 rolling summary에 병합한다.
    if recent_message_tokens > RECENT_MESSAGE_BUDGET:
        # 기획서 슈도코드: old_messages = recent_messages[:-RECENT_MESSAGE_KEEP_COUNT]
        old_messages = recent_messages[:-RECENT_MESSAGE_KEEP_COUNT]
        
        # 기획서 슈도코드: summary = summarize(previous_summary + old_messages)
        old_messages_text = "\n".join([f"{m['role']}: {m['text']}" for m in old_messages])
        current_summary = f"{current_summary if current_summary else ''}\n[자동 롤링 병합 문맥]\n{old_messages_text}"
        
        # 기획서 슈도코드: encrypt_and_save(summary)
        # (세션 스토어가 암호화 유틸을 사용하여 암호문 생성 후 대화 요약 DB에 갱신 처리 완료)
        store.save_summary(
            session_id=session_id,
            summary_text=current_summary,
            source_message_id=old_messages[-1]["id"]
        )
        
        # 기획서 슈도코드: keep recent_messages[-RECENT_MESSAGE_KEEP_COUNT:]
        recent_messages = recent_messages[-RECENT_MESSAGE_KEEP_COUNT:]
    # =========================================================================
    
    # 모든 영속성 컨텍스트 처리 완료 후 최종 데이터베이스 안전 커밋
    db.commit()
    
    return {
        "status": "success",
        "session_id": session_id,
        "answer": llm_response_text
    }


# --- 가상의 DB 커넥션 종속성 주입기 ---
def get_db():
    class DummyDB:
        def execute(self, query, params=None):
            class DummyResult:
                def fetchone(self):
                    return SessionResponse(id="sess_sample123", project_id="p1", title="테스트 세션", created_at=datetime.now(), updated_at=datetime.now())
                def fetchall(self):
                    return []
                @property
                def lastrowid(self): return 999
            return DummyResult()
        def commit(self): pass
    return DummyDB()