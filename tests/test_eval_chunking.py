from evals.eval_chunking import score_items


def test_score_items_matches_keywords_case_insensitive():
    extracted = [
        {"category": "decision", "content": "MySQL 컬럼 추가를 확정", "owner": None, "date": "2026-06-30"},
    ]
    golden = [
        {"category": "decision", "must_include": ["mysql", "확정"], "owner": None, "date": "2026-06-30"},
    ]

    score = score_items(extracted, golden)

    assert score["recall"] == 1.0
    assert score["precision"] == 1.0
    assert score["date_accuracy"] == 1.0


def test_score_items_counts_duplicates():
    extracted = [
        {"category": "action", "content": "김민수 API 문서 작성", "owner": "김민수", "date": "2026-06-30"},
        {"category": "action", "content": "김민수 API 문서 작성", "owner": "김민수", "date": "2026-06-30"},
    ]
    golden = [
        {"category": "action", "must_include": ["김민수", "API 문서"], "owner": "김민수", "date": "2026-06-30"},
    ]

    score = score_items(extracted, golden)

    assert score["recall"] == 1.0
    assert score["precision"] == 0.5
    assert score["owner_accuracy"] == 1.0
    assert score["duplicates"] == 1


def test_score_items_reports_unmatched_goldens():
    extracted = [
        {"category": "risk", "content": "Windows 설치 파일 누락 가능성", "owner": None, "date": "2026-07-01"},
    ]
    golden = [
        {"category": "issue", "must_include": ["알림", "중복"], "owner": None, "date": "2026-07-01"},
    ]

    score = score_items(extracted, golden)

    assert score["recall"] == 0.0
    assert score["precision"] == 0.0
    assert score["unmatched"] == golden
