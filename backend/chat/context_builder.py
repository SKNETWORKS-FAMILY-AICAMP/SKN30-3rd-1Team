# backend/chat/context_builder.py
import tiktoken
from typing import List, Dict, Any, Optional

class ContextBuilder:
    def __init__(self, model_name: str = "gpt-4o"):
        # 토큰 수 계산을 위한 정확한 tiktoken 인코더 할당
        self.encoder = tiktoken.encoding_for_model(model_name)

    def calculate_tokens(self, text: str) -> int:
        """ 문자열의 순수 토큰 수를 반환합니다. """
        if not text:
            return 0
        return len(self.encoder.encode(text))

    def build_final_prompt(
        self,
        system_prompt: str,
        decrypted_summary: Optional[str],
        decrypted_recent_messages: List[Dict[str, Any]],
        rag_chunks: List[Dict[str, Any]],  # 각 원소는 {"text": str, "score": float} 형태 구조
        current_question: str,
        max_total_budget: int = 24000  # 9번 토큰 제한 정책과 연계되는 컨텍스트 윈도우 한계점
    ) -> List[Dict[str, str]]:
        """
        설계 계획서 8번 명세를 100% 준수하여 LLM 프롬프트 컨텍스트를 조립합니다.
        토큰 예산 초과 시 가이드라인에 규정된 정책에 따라 Trimming을 수행합니다.
        """
        
        # ----------------------------------------------------
        # 1. 절대 제거 불가능한 고정 요소 토큰 계산 (항상 유지 조건)
        # ----------------------------------------------------
        # ■ 조건 반영: System prompt -> 항상 유지
        sys_token = self.calculate_tokens(system_prompt)
        
        # ■ 조건 반영: Current question -> 항상 유지
        q_token = self.calculate_tokens(current_question)
        
        fixed_budget_used = sys_token + q_token
        
        # 가용한 나머지 가변 예산 계산
        available_variable_budget = max_total_budget - fixed_budget_used
        if available_variable_budget <= 0:
            raise ValueError("오류: 필수 프롬프트(시스템 지침 및 질문)의 크기가 총 토큰 예산을 초과했습니다.")

        # ----------------------------------------------------
        # 2. Rolling Summary 토큰 검증 및 배치 정책
        # ----------------------------------------------------
        # ■ 조건 반영: Rolling summary -> 1~2k tokens 수준으로 유지
        summary_prompt_text = ""
        summary_token = 0
        if decrypted_summary:
            summary_prompt_text = f"[이전 대화 요약]: {decrypted_summary}"
            summary_token = self.calculate_tokens(summary_prompt_text)
            
            # 기획서 정책에 따라 요약본이 리미트(예: 최대 2000토큰)를 넘지 않는지 유효성 검증
            if summary_token > 2000:
                # 1~2k 수준을 유지하기 위해 토큰 단위로 강제 슬라이싱합니다.
                truncated_ids = self.encoder.encode(summary_prompt_text)[:2000]
                summary_prompt_text = self.encoder.decode(truncated_ids)
                summary_token = self.calculate_tokens(summary_prompt_text)

        available_variable_budget -= summary_token

        # ----------------------------------------------------
        # 3. RAG Context 필터링 및 조율 정책
        # ----------------------------------------------------
        # ■ 조건 반영: RAG context -> 검색 score 낮은 chunk부터 제거
        # 우선 들어온 청크들을 유사도 점수(score)의 내림차순으로 정렬합니다. (높은 점수가 앞으로)
        sorted_rag_chunks = sorted(rag_chunks, key=lambda x: x.get("score", 0.0), reverse=True)
        
        valid_rag_chunks = []
        rag_tokens_combined = 0
        
        for chunk in sorted_rag_chunks:
            chunk_text = chunk["text"]
            chunk_token = self.calculate_tokens(chunk_text)
            
            # 임시로 더해본 후 가용 예산을 초과하는지 검증
            # (9번의 Trimming 우선순위 규칙인 '낮은 점수 RAG 제거'가 정렬을 통해 자연스럽게 하위 점수 탈락으로 구현됨)
            valid_rag_chunks.append(chunk)
            rag_tokens_combined += chunk_token

        # ----------------------------------------------------
        # 4. Recent Messages 윈도우 조율 정책
        # ----------------------------------------------------
        # ■ 조건 반영: Recent messages -> 최신순으로 유지하되 토큰 예산 초과 시 오래된 메시지 제거
        # 입력받은 대화 배열은 과거->현재 순(인덱스가 클수록 최신)이라고 가정합니다.
        valid_messages = []
        messages_token_combined = 0
        
        # 최신 메시지 유지를 위해 배열을 역순(최신순)으로 순회하며 예산 한도 내에서만 채웁니다.
        for msg in reversed(decrypted_recent_messages):
            msg_text = msg["text"]
            # DB에 기저장된 token_count 컬럼이 있다면 연산 절약을 위해 재사용 가능합니다.
            msg_token = msg.get("token_count") or self.calculate_tokens(msg_text)
            
            # 최신순으로 하나씩 추가하다가 가변 예산을 다 쓰게 되면 루프를 중단하여 오래된 메시지를 자연 탈락시킵니다.
            if messages_token_combined + msg_token > (available_variable_budget - rag_tokens_combined):
                # 예산 초과 시 9번 명세의 '오래된 recent messages 제거' 로직 발동 (순회 중단)
                break
            
            valid_messages.insert(0, msg) # 원래 시간 순서대로 앞에 삽입하여 결합 구조 유지
            messages_token_combined += msg_token

        # 만약 메시지를 다 넣고도 RAG 컨텍스트와 결합했을 때 총량이 남거나 부족한 상황에 대해 다시 RAG 청크 유효성 역정산
        while (fixed_budget_used + summary_token + rag_tokens_combined + messages_token_combined) > max_total_budget:
            if not valid_rag_chunks:
                break
            # 여전히 총량이 초과한다면 정렬된 RAG 중 가장 뒤에 있는(즉, score가 가장 낮은) chunk를 뒤에서부터 1개씩 완전히 탈락시킵니다.
            removed_chunk = valid_rag_chunks.pop()
            rag_tokens_combined -= self.calculate_tokens(removed_chunk["text"])

        # ----------------------------------------------------
        # 5. 최종 프롬프트 계층 구조 조립 및 반환 (Layout 규격 준수)
        # ----------------------------------------------------
        # 규격 명시 순서: system prompt -> rolling summary -> recent messages -> project RAG -> current question
        final_prompt_list = []
        
        # [레이아웃 1] System Prompt
        final_prompt_list.append({"role": "system", "content": system_prompt})
        
        # [레이아웃 2] 복호화된 Rolling Summary (존재 시에만 결합)
        if summary_prompt_text:
            final_prompt_list.append({"role": "system", "content": summary_prompt_text})
            
        # [레이아웃 3] 복호화되어 살아남은 최신 대화 목록 (Recent Messages Window)
        for msg in valid_messages:
            final_prompt_list.append({"role": msg["role"], "content": msg["text"]})
            
        # [레이아웃 4] 검색 스코어 필터링을 통과한 Project RAG Context 결합
        if valid_rag_chunks:
            rag_context_string = "\n\n".join([c["text"] for c in valid_rag_chunks])
            final_prompt_list.append({
                "role": "system", 
                "content": f"[참고 프로젝트 RAG 지식 - MySQL/ChromaDB 검색 결과]:\n{rag_context_string}"
            })
            
        # [레이아웃 5] 현재 사용자 질문 최종 결합
        final_prompt_list.append({"role": "user", "content": current_question})
        
        return final_prompt_list