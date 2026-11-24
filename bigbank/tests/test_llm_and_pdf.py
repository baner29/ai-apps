"""Tests for provider-agnostic LLM evaluator and role-agnostic PDF report generator."""

from __future__ import annotations

import asyncio
import json
import re
import sys
import types
import zlib
from unittest.mock import AsyncMock, MagicMock, patch

from backend.config import Settings
from backend.services.llm import LLMService, _extract_gemini_text, format_notebook_answer
from backend.services.pdf_report import generate_interview_pdf


def _make_openai_json(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def _make_anthropic_json(content: str) -> dict:
    return {"content": [{"type": "text", "text": content}]}


def _make_gemini_json(content: str) -> dict:
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": content}]}}]}


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    """Decompress FlateDecode PDF streams to inspect rendered text in tests."""
    chunks: list[str] = []
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", pdf_bytes, re.DOTALL):
        raw = match.group(1)
        try:
            decoded = zlib.decompress(raw).decode("latin-1", errors="ignore")
        except zlib.error:
            decoded = raw.decode("latin-1", errors="ignore")
        chunks.append(decoded)
    return "\n".join(chunks)


def test_llm_none_provider_falls_back_gracefully():
    svc = LLMService(Settings(llm_provider="none"))
    res = asyncio.run(
        svc.score_answer(
            {
                "prompt": "Design a feature",
                "format": "text",
                "difficulty": "medium",
                "effective_points": 25,
                "effective_rubric": "Clarity",
            },
            "My answer",
            role_title="Product Manager",
        )
    )
    assert res["needs_manual_review"] is True
    assert res["score"] == 0 and res["max_points"] == 25
    assert "Manual Review" in res["feedback"]


def test_llm_rubric_scoring_clamps_score_and_parses_fenced_json():
    svc = LLMService(
        Settings(llm_provider="openai", llm_model="gpt-4o", llm_api_key="sk-test")
    )
    mock_post = AsyncMock(
        return_value=_make_openai_json(
            '```json\n{"score": 999, "correctness_pct": 90, "rubric_breakdown": ["Good tradeoffs"], "feedback": "Strong answer"}\n```'
        )
    )
    with patch("backend.services.llm._post_json", new=mock_post):
        res = asyncio.run(
            svc.score_answer(
                {
                    "prompt": "RAG?",
                    "format": "text",
                    "difficulty": "hard",
                    "effective_points": 30,
                    "effective_rubric": "Check recall",
                    "effective_expected_answer": "Hybrid",
                },
                "Use hybrid search",
                role_title="AI Engineer",
            )
        )
    assert mock_post.call_args.args[0] == "https://api.openai.com/v1/chat/completions"
    assert res["score"] == 30 and res["max_points"] == 30
    assert res["correctness_pct"] == 90
    assert res["rubric_breakdown"] == ["Good tradeoffs"]
    assert res["needs_manual_review"] is False


def test_pdf_renders_custom_dimensions_notebook_cells_and_manual_override():
    nb_answer = json.dumps(
        {"cells": [{"type": "code", "source": "x = 1 + 1\nprint(x)", "output": "2"}]}
    )
    assert "Cell 1" in format_notebook_answer(nb_answer)
    pdf_bytes = generate_interview_pdf(
        {
            "candidate_name": "Alex Rivera",
            "role_title": "AI Data Engineer",
            "template_name": "AI DE L4",
            "final_score": 45,
            "max_score": 50,
            "score_percentage": 90.0,
            "total_questions": 2,
            "attempted_questions": 2,
            "duration_seconds": 900,
            "summary": {
                "overall_feedback": "Strong.",
                "strengths": "Great design.",
                "areas_of_opportunity": "Edge cases.",
                "dimensions": {
                    "Data Pipelines": "Advanced",
                    "LLM Systems": "Strong",
                },
            },
            "answers": [
                {
                    "question_text": "Write pipeline",
                    "question_format": "notebook",
                    "difficulty": "hard",
                    "scoring_criteria": "Clean code",
                    "expected_answer": "Vectorized",
                    "candidate_answer_text": format_notebook_answer(nb_answer),
                    "evaluation": {
                        "score": 25,
                        "max_points": 30,
                        "correctness_pct": 83,
                        "rubric_breakdown": ["Correct output"],
                        "feedback": "Well structured \u2014 em-dash test",
                        "manually_overridden": True,
                    },
                }
            ],
        }
    )
    assert pdf_bytes.startswith(b"%PDF") and len(pdf_bytes) > 1000
    rendered = _extract_pdf_text(pdf_bytes)
    assert "AI Data Engineer" in rendered
    assert "AI DE L4" in rendered
    assert "Data Pipelines" in rendered
    assert "LLM Systems" in rendered
    assert "Manually Reviewed" in rendered
    assert "Correct output" in rendered
    assert "Cell 1" in rendered


def test_llm_is_configured_and_model_mapping():
    assert LLMService(Settings(llm_provider="none")).is_configured() is False
    assert (
        LLMService(
            Settings(llm_provider="openai", llm_model="gpt-4o", llm_api_key="")
        ).is_configured()
        is False
    )
    assert (
        LLMService(
            Settings(llm_provider="openai", llm_model="gpt-4o", llm_api_key="sk-123")
        ).is_configured()
        is True
    )
    assert (
        LLMService(
            Settings(llm_provider="ollama", llm_model="llama3.1")
        ).is_configured()
        is True
    )
    assert (
        LLMService(
            Settings(llm_provider="vertex_ai", llm_model="gemini-2.5-pro")
        ).is_configured()
        is True
    )
    assert (
        LLMService(
            Settings(llm_provider="bedrock", llm_model="anthropic.claude-3-sonnet")
        ).is_configured()
        is True
    )
    assert (
        LLMService(
            Settings(
                llm_provider="openai_compatible",
                llm_model="qwen2.5",
                llm_base_url="http://localhost:8000/v1",
            )
        ).is_configured()
        is True
    )

    cases = [
        ("openai", "gpt-4o", "gpt-4o"),
        ("anthropic", "claude-3-5-sonnet-20241022", "anthropic/claude-3-5-sonnet-20241022"),
        ("anthropic", "anthropic/claude-3-5-sonnet", "anthropic/claude-3-5-sonnet"),
        ("gemini", "gemini-2.0-flash", "gemini/gemini-2.0-flash"),
        ("vertex_ai", "gemini-2.5-pro", "vertex_ai/gemini-2.5-pro"),
        ("azure", "my-gpt4-deploy", "azure/my-gpt4-deploy"),
        ("bedrock", "anthropic.claude-3-sonnet", "bedrock/anthropic.claude-3-sonnet"),
        ("ollama", "llama3.1", "ollama/llama3.1"),
        ("openai_compatible", "qwen2.5", "openai/qwen2.5"),
    ]
    for provider, model, expected in cases:
        svc = LLMService(Settings(llm_provider=provider, llm_model=model))
        assert svc.resolve_model_name() == expected


def test_llm_score_answer_passes_credentials_formats_notebook_and_handles_edge_cases():
    svc = LLMService(
        Settings(
            llm_provider="anthropic",
            llm_model="claude-3-5-sonnet",
            llm_api_key="sk-ant-secret",
            llm_base_url="https://proxy.example.com/v1",
        )
    )

    # Blank answer returns zero without invoking LLM
    with patch("backend.services.llm._post_json", new=AsyncMock()) as mock_post:
        blank_res = asyncio.run(
            svc.score_answer(
                {"prompt": "Explain SQL", "format": "text", "effective_points": 20},
                "   ",
                role_title="Data Analyst",
            )
        )
        assert mock_post.await_count == 0
        assert blank_res["score"] == 0 and blank_res["max_points"] == 20
        assert blank_res["needs_manual_review"] is False

    # Negative score clamps to 0, notebook JSON is formatted, x-api-key & custom base_url used
    mock_resp = _make_anthropic_json(
        'Here is the evaluation: {"score": -5, "correctness_pct": -10, "rubric_breakdown": ["Incomplete"], "feedback": "Needs work"}'
    )
    nb_json = json.dumps(
        {
            "cells": [
                {"type": "markdown", "source": "## Approach"},
                {
                    "type": "code",
                    "source": "print(42)",
                    "output": "42",
                    "images": ["data:image/png;base64,AAAA"],
                },
            ]
        }
    )
    with patch("backend.services.llm._post_json", new=AsyncMock(return_value=mock_resp)) as mock_post:
        res = asyncio.run(
            svc.score_answer(
                {
                    "prompt": "Compute metric",
                    "format": "notebook",
                    "difficulty": "medium",
                    "effective_points": 20,
                    "effective_rubric": "Correct calculation",
                    "effective_expected_answer": "42",
                },
                nb_json,
                role_title="Analytics Engineer",
            )
        )
        assert res["score"] == 0 and res["correctness_pct"] == 0
        url_arg = mock_post.call_args.args[0]
        call_kwargs = mock_post.call_args.kwargs
        assert url_arg == "https://proxy.example.com/v1/messages"
        assert call_kwargs["headers"]["x-api-key"] == "sk-ant-secret"
        assert call_kwargs["payload"]["model"] == "claude-3-5-sonnet"
        user_msg = call_kwargs["payload"]["messages"][-1]["content"]
        assert "Cell 2" in user_msg
        assert "Analytics Engineer" in user_msg
        assert "data:image/png;base64,AAAA" not in user_msg

    # LLM exception falls back cleanly to manual review
    with patch(
        "backend.services.llm._post_json", new=AsyncMock(side_effect=RuntimeError("API timeout"))
    ):
        err_res = asyncio.run(
            svc.score_answer(
                {"prompt": "Q", "format": "text", "effective_points": 15},
                "Some answer",
                role_title="Backend Engineer",
            )
        )
        assert err_res["needs_manual_review"] is True
        assert err_res["score"] == 0 and err_res["max_points"] == 15
        assert "Manual Review" in err_res["feedback"]


def test_llm_generate_summary_and_fallback():
    # Unconfigured fallback preserves requested dimensions
    none_svc = LLMService(Settings(llm_provider="none"))
    fallback = asyncio.run(
        none_svc.generate_summary(
            candidate_name="Jordan",
            role_title="Product Manager",
            summary_dimensions=["Product Strategy", "Stakeholder Communication"],
            results={"final_score": 0, "max_score": 50},
        )
    )
    assert "Manual Review" in fallback["overall_feedback"]
    assert set(fallback["dimensions"].keys()) == {
        "Product Strategy",
        "Stakeholder Communication",
    }

    # Configured provider parses dynamic dimensions
    svc = LLMService(
        Settings(llm_provider="openai", llm_model="gpt-4o-mini", llm_api_key="sk-test")
    )
    summary_json = json.dumps(
        {
            "overall_feedback": "Clear product sense and structured trade-offs.",
            "strengths": "Strong prioritization framework.",
            "areas_of_opportunity": "Deeper instrumentation metrics.",
            "dimensions": {
                "Product Strategy": "Strong",
                "Stakeholder Communication": "Advanced",
            },
        }
    )
    with patch(
        "backend.services.llm._post_json",
        new=AsyncMock(return_value=_make_openai_json(f"```json\n{summary_json}\n```")),
    ):
        out = asyncio.run(
            svc.generate_summary(
                candidate_name="Jordan",
                role_title="Product Manager",
                summary_dimensions=["Product Strategy", "Stakeholder Communication"],
                results={"final_score": 42, "max_score": 50, "answers": []},
            )
        )
    assert out["overall_feedback"] == "Clear product sense and structured trade-offs."
    assert out["strengths"] == "Strong prioritization framework."
    assert out["areas_of_opportunity"] == "Deeper instrumentation metrics."
    assert out["dimensions"] == {
        "Product Strategy": "Strong",
        "Stakeholder Communication": "Advanced",
    }


def test_llm_test_connection_states_and_secret_scrubbing():
    none_svc = LLMService(Settings(llm_provider="none"))
    res_none = asyncio.run(none_svc.test_connection())
    assert res_none["ok"] is False
    assert res_none["provider"] == "none"

    svc = LLMService(
        Settings(
            llm_provider="openai",
            llm_model="gpt-4o-mini",
            llm_api_key="sk-super-secret-value",
        )
    )
    with patch(
        "backend.services.llm._post_json",
        new=AsyncMock(return_value=_make_openai_json("OK")),
    ):
        res_ok = asyncio.run(svc.test_connection())
        assert res_ok["ok"] is True
        assert res_ok["provider"] == "openai"
        assert res_ok["model"] == "gpt-4o-mini"

    with patch(
        "backend.services.llm._post_json",
        new=AsyncMock(
            side_effect=RuntimeError("Auth failed for key sk-super-secret-value")
        ),
    ):
        res_err = asyncio.run(svc.test_connection())
        assert res_err["ok"] is False
        assert "sk-super-secret-value" not in res_err["detail"]


def test_format_notebook_answer_handles_errors_plain_text_and_jupyter_outputs():
    assert format_notebook_answer("") == ""
    assert format_notebook_answer("plain text answer") == "plain text answer"

    rich_nb = json.dumps(
        {
            "cells": [
                {
                    "type": "code",
                    "source": ["import math\n", "print(math.sqrt(9))"],
                    "stdout": "3.0",
                    "stderr": "DeprecationWarning",
                    "images": ["img1", "img2"],
                },
                {
                    "type": "code",
                    "source": "1 / 0",
                    "error": "ZeroDivisionError: division by zero",
                },
            ]
        }
    )
    formatted = format_notebook_answer(rich_nb)
    assert "Cell 1" in formatted
    assert "3.0" in formatted
    assert "DeprecationWarning" in formatted
    assert "2 image" in formatted.lower() or "plot" in formatted.lower()
    assert "Cell 2" in formatted
    assert "ZeroDivisionError" in formatted


def test_pdf_handles_unicode_unattempted_and_long_tokens():
    pdf_bytes = generate_interview_pdf(
        {
            "candidate_name": "M\u00e9lanie \u201cMel\u201d Chen \U0001f680",
            "candidate_email": "mel@example.com",
            "role_title": "Staff ML Engineer",
            "template_name": "ML Core Assessment",
            "final_score": 0,
            "max_score": 20,
            "total_questions": 1,
            "attempted_questions": 0,
            "duration_seconds": 65,
            "summary": {
                "overall_feedback": "Pending review \u2014 no answers submitted.",
                "strengths": "N/A",
                "areas_of_opportunity": "Complete all items \u2026",
                "dimensions": {},
            },
            "answers": [
                {
                    "question_text": "Explain attention mechanism " + ("X" * 160),
                    "question_format": "text",
                    "difficulty": "medium",
                    "scoring_criteria": "Clarity \u2022 Depth",
                    "expected_answer": "Q\u00b7K^T / sqrt(d_k)",
                    "candidate_answer": "",
                    "evaluation": {
                        "score": 0,
                        "max_points": 20,
                        "correctness_pct": 0,
                        "rubric_breakdown": [],
                        "feedback": "No answer provided.",
                        "needs_manual_review": True,
                    },
                }
            ],
        }
    )
    assert pdf_bytes.startswith(b"%PDF") and len(pdf_bytes) > 800
    rendered = _extract_pdf_text(pdf_bytes)
    assert "Staff ML Engineer" in rendered
    assert "ML Core Assessment" in rendered
    assert "Pending Manual Review" in rendered


def test_llm_parallel_gather_and_pdf_long_dimension_labels():
    svc = LLMService(
        Settings(
            llm_provider="openai_compatible",
            llm_model="qwen2.5",
            llm_base_url="http://localhost:8000/v1",
        )
    )
    responses = [
        _make_openai_json('{"score": 18, "correctness_pct": 90, "rubric_breakdown": ["Solid"], "feedback": "Good 1"}'),
        _make_openai_json('{"score": 24, "correctness_pct": 80, "rubric_breakdown": ["Clear"], "feedback": "Good 2"}'),
    ]

    async def _run_parallel():
        with patch("backend.services.llm._post_json", new=AsyncMock(side_effect=responses)) as mock_post:
            out = await asyncio.gather(
                svc.score_answer(
                    {"prompt": "Q1", "format": "text", "effective_points": 20},
                    "A1",
                    role_title="Platform Engineer",
                ),
                svc.score_answer(
                    {"prompt": "Q2", "format": "code", "effective_points": 30},
                    "def f(): return 1",
                    role_title="Platform Engineer",
                ),
            )
            assert mock_post.await_count == 2
            assert mock_post.call_args_list[0].args[0] == "http://localhost:8000/v1/chat/completions"
            assert mock_post.call_args_list[0].kwargs["headers"]["Authorization"] == "Bearer local"
            return out

    r1, r2 = asyncio.run(_run_parallel())
    assert r1["score"] == 18 and r2["score"] == 24

    pdf_bytes = generate_interview_pdf(
        {
            "candidate_name": "Samira Patel",
            "role_title": "Principal Product Manager",
            "template_name": "PM Executive Loop",
            "final_score": 42,
            "max_score": 50,
            "summary": {
                "overall_feedback": "Strong executive presence.",
                "strengths": "Clear strategy.",
                "areas_of_opportunity": "More quantitative depth.",
                "dimensions": {
                    "Cross-Functional Stakeholder Communication & Alignment": "Advanced — leads alignment clearly",
                },
            },
            "answers": [],
        }
    )
    assert pdf_bytes.startswith(b"%PDF")
    rendered = _extract_pdf_text(pdf_bytes)
    assert "Cross-Functional Stakeholder Communication" in rendered


def test_format_notebook_answer_preserves_text_after_base64_data_uri():
    nb_json = json.dumps(
        {
            "cells": [
                {
                    "type": "code",
                    "source": "plot_and_print()",
                    "output": "Plot: data:image/png;base64,iVBORw0KGgoAAA==\nResult is 42\nDone.",
                }
            ]
        }
    )
    formatted = format_notebook_answer(nb_json)
    assert "[Image output omitted]" in formatted
    assert "iVBORw0KGgoAAA==" not in formatted
    assert "Result is 42" in formatted
    assert "Done." in formatted


def test_resolve_model_name_prefixes_org_slash_models_for_compatible_providers():
    cases = [
        ("openai_compatible", "Qwen/Qwen2.5-72B-Instruct", "openai/Qwen/Qwen2.5-72B-Instruct"),
        ("openai_compatible", "openai/Qwen/Qwen2.5-72B-Instruct", "openai/Qwen/Qwen2.5-72B-Instruct"),
        ("custom", "meta-llama/Llama-3.1-8B-Instruct", "openai/meta-llama/Llama-3.1-8B-Instruct"),
        ("together_ai", "meta-llama/Llama-3.1-8B-Instruct", "together_ai/meta-llama/Llama-3.1-8B-Instruct"),
        ("together_ai", "together_ai/meta-llama/Llama-3.1-8B-Instruct", "together_ai/meta-llama/Llama-3.1-8B-Instruct"),
        ("groq", "meta-llama/llama-4-scout-17b-16e-instruct", "groq/meta-llama/llama-4-scout-17b-16e-instruct"),
        ("ollama", "hf.co/Qwen/Qwen2.5-7B-GGUF", "ollama/hf.co/Qwen/Qwen2.5-7B-GGUF"),
        ("ollama", "ollama/hf.co/Qwen/Qwen2.5-7B-GGUF", "ollama/hf.co/Qwen/Qwen2.5-7B-GGUF"),
    ]
    for provider, model, expected in cases:
        svc = LLMService(Settings(llm_provider=provider, llm_model=model))
        assert svc.resolve_model_name() == expected


def test_pdf_feedback_tinting_handles_string_pct_and_manual_override_without_pct():
    from backend.services.pdf_report import _InterviewReportPDF

    recorded_fills: list[tuple[str, tuple[int, int, int]]] = []
    original_tinted_box = _InterviewReportPDF.tinted_box

    def spy_tinted_box(self, text, **kwargs):
        recorded_fills.append((text, kwargs.get("fill_color", (241, 245, 249))))
        return original_tinted_box(self, text, **kwargs)

    with patch.object(_InterviewReportPDF, "tinted_box", spy_tinted_box):
        pdf_bytes = generate_interview_pdf(
            {
                "candidate_name": "Dana Kim",
                "role_title": "Data Engineer",
                "template_name": "DE Core",
                "final_score": 45,
                "max_score": 50,
                "answers": [
                    {
                        "question_text": "Q1 string pct",
                        "question_format": "text",
                        "difficulty": "medium",
                        "candidate_answer_text": "Solid answer",
                        "evaluation": {
                            "score": 17,
                            "max_points": 20,
                            "correctness_pct": "85",
                            "feedback": "Numeric string pct feedback",
                        },
                    },
                    {
                        "question_text": "Q2 manual override missing pct",
                        "question_format": "text",
                        "difficulty": "hard",
                        "candidate_answer_text": "Detailed manual answer",
                        "evaluation": {
                            "score": 28,
                            "max_points": 30,
                            "correctness_pct": None,
                            "manually_overridden": True,
                            "needs_manual_review": True,
                            "feedback": "Manual override passing feedback",
                        },
                    },
                ],
            }
        )

    assert pdf_bytes.startswith(b"%PDF")
    fill_by_text = dict(recorded_fills)
    # Both passing feedback boxes must use green tint (236, 253, 245), never rose (255, 241, 242)
    assert fill_by_text["Numeric string pct feedback"] == (236, 253, 245)
    assert fill_by_text["Manual override passing feedback"] == (236, 253, 245)


def test_llm_non_finite_score_falls_back_to_manual_review_and_sanitizes_pct():
    """Regression test: NaN/Infinity LLM scores must never award 100% and must trigger manual review."""
    svc = LLMService(
        Settings(llm_provider="openai", llm_model="gpt-4o", llm_api_key="sk-test")
    )
    q = {
        "prompt": "Explain CAP theorem",
        "format": "text",
        "difficulty": "medium",
        "effective_points": 20,
    }

    for bad_score in ("NaN", "Infinity", "-Infinity", "inf", "-inf"):
        mock_resp = _make_openai_json(
            json.dumps({"score": bad_score, "correctness_pct": 100, "feedback": "bad"})
        )
        with patch("backend.services.llm._post_json", new=AsyncMock(return_value=mock_resp)):
            res = asyncio.run(svc.score_answer(q, "Some answer", role_title="Engineer"))
        assert res["score"] == 0.0, f"Non-finite score {bad_score} must not award points"
        assert res["correctness_pct"] == 0.0
        assert res["needs_manual_review"] is True

    # Valid score with non-finite correctness_pct falls back to clamped_score / max_points * 100
    mock_pct_nan = _make_openai_json(
        json.dumps({"score": 15, "correctness_pct": "NaN", "feedback": "Good"})
    )
    with patch("backend.services.llm._post_json", new=AsyncMock(return_value=mock_pct_nan)):
        res_pct = asyncio.run(svc.score_answer(q, "Good answer", role_title="Engineer"))
    assert res_pct["needs_manual_review"] is False
    assert res_pct["score"] == 15.0
    assert res_pct["correctness_pct"] == 75.0


def test_vertex_ai_isolated_endpoint_uses_adc_and_never_touches_openai_or_litellm(monkeypatch):
    """Selecting vertex_ai must hit only Vertex AI directly and never import/call litellm or tiktoken."""
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "your-gcp-project-id")
    monkeypatch.delenv("VERTEXAI_PROJECT", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    monkeypatch.setenv("GOOGLE_CLOUD_REGION", "us-central1")

    fake_creds = MagicMock(token="ya29.fake-vertex-token", quota_project_id=None)
    fake_google_auth = types.ModuleType("google.auth")
    fake_google_auth.default = MagicMock(return_value=(fake_creds, "demo-adc-project"))
    fake_requests = types.ModuleType("google.auth.transport.requests")
    fake_requests.Request = MagicMock()
    fake_transport = types.ModuleType("google.auth.transport")
    fake_transport.requests = fake_requests
    fake_google = types.ModuleType("google")
    fake_google.auth = fake_google_auth

    mock_post = AsyncMock(return_value=_make_gemini_json("OK"))
    svc = LLMService(Settings(llm_provider="vertex_ai", llm_model="gemini-3.8-flash"))

    # Block any accidental import of litellm or tiktoken during vertex_ai execution
    sys_patch = {
        "litellm": None,
        "tiktoken": None,
        "openai": None,
        "boto3": None,
        "google": fake_google,
        "google.auth": fake_google_auth,
        "google.auth.transport": fake_transport,
        "google.auth.transport.requests": fake_requests,
    }
    with patch.dict(sys.modules, sys_patch):
        with patch("backend.services.llm._post_json", new=mock_post):
            res = asyncio.run(svc.test_connection())

    assert res["ok"] is True
    assert res["provider"] == "vertex_ai"
    url = mock_post.call_args.args[0]
    assert url == (
        "https://aiplatform.googleapis.com/v1/projects/demo-adc-project"
        "/locations/global/publishers/google/models/gemini-3.8-flash:generateContent"
    )
    assert mock_post.call_args.kwargs["headers"]["Authorization"] == "Bearer ya29.fake-vertex-token"
    assert mock_post.call_args.kwargs["payload"]["generationConfig"]["maxOutputTokens"] == 256


def test_vertex_ai_ignores_thought_parts_and_regional_endpoints(monkeypatch):
    parsed = _extract_gemini_text(
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "internal thought", "thought": True},
                            {"text": "OK.", "thoughtSignature": "sig"},
                        ]
                    }
                }
            ]
        }
    )
    assert parsed == "OK."

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "real-project-123")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "")
    monkeypatch.setenv("GOOGLE_CLOUD_REGION", "europe-west1")

    fake_creds = MagicMock(token="ya29.regional-token")
    fake_google_auth = types.ModuleType("google.auth")
    fake_google_auth.default = MagicMock(return_value=(fake_creds, "ignored-project"))
    fake_requests = types.ModuleType("google.auth.transport.requests")
    fake_requests.Request = MagicMock()
    fake_transport = types.ModuleType("google.auth.transport")
    fake_transport.requests = fake_requests
    fake_google = types.ModuleType("google")
    fake_google.auth = fake_google_auth

    mock_post = AsyncMock(return_value=_make_gemini_json("OK"))
    svc = LLMService(Settings(llm_provider="vertex_ai", llm_model="vertex_ai/gemini-2.5-pro"))
    with patch.dict(
        sys.modules,
        {
            "google": fake_google,
            "google.auth": fake_google_auth,
            "google.auth.transport": fake_transport,
            "google.auth.transport.requests": fake_requests,
        },
    ):
        with patch("backend.services.llm._post_json", new=mock_post):
            res = asyncio.run(svc.test_connection())

    assert res["ok"] is True
    assert mock_post.call_args.args[0] == (
        "https://europe-west1-aiplatform.googleapis.com/v1/projects/real-project-123"
        "/locations/europe-west1/publishers/google/models/gemini-2.5-pro:generateContent"
    )


def test_each_selected_provider_dispatches_only_to_its_own_adapter():
    # Gemini API key adapter
    gemini_svc = LLMService(
        Settings(llm_provider="gemini", llm_model="gemini-2.5-flash", llm_api_key="AIza-key")
    )
    mock_post = AsyncMock(return_value=_make_gemini_json("OK"))
    with patch("backend.services.llm._post_json", new=mock_post):
        assert asyncio.run(gemini_svc.test_connection())["ok"] is True
    assert mock_post.call_args.args[0] == (
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    )
    assert mock_post.call_args.kwargs["headers"]["x-goog-api-key"] == "AIza-key"

    # Ollama adapter
    ollama_svc = LLMService(
        Settings(llm_provider="ollama", llm_model="ollama/llama3.1")
    )
    mock_post = AsyncMock(return_value={"message": {"content": "OK"}})
    with patch("backend.services.llm._post_json", new=mock_post):
        assert asyncio.run(ollama_svc.test_connection())["ok"] is True
    assert mock_post.call_args.args[0] == "http://localhost:11434/api/chat"
    assert mock_post.call_args.kwargs["payload"]["model"] == "llama3.1"

    # Azure OpenAI adapter
    azure_svc = LLMService(
        Settings(
            llm_provider="azure",
            llm_model="my-deploy",
            llm_api_key="az-secret",
            llm_base_url="https://example.openai.azure.com",
        )
    )
    mock_post = AsyncMock(return_value=_make_openai_json("OK"))
    with patch("backend.services.llm._post_json", new=mock_post):
        assert asyncio.run(azure_svc.test_connection())["ok"] is True
    assert (
        mock_post.call_args.args[0]
        == "https://example.openai.azure.com/openai/deployments/my-deploy/chat/completions"
    )
    assert mock_post.call_args.kwargs["headers"]["api-key"] == "az-secret"

    # AWS Bedrock adapter (lazy boto3 only)
    bedrock_client = MagicMock()
    bedrock_client.converse.return_value = {
        "output": {"message": {"content": [{"text": "OK"}]}}
    }
    fake_boto3 = types.ModuleType("boto3")
    fake_boto3.client = MagicMock(return_value=bedrock_client)
    fake_botocore_config = types.ModuleType("botocore.config")
    fake_botocore_config.Config = MagicMock()
    fake_botocore = types.ModuleType("botocore")
    fake_botocore.config = fake_botocore_config
    bedrock_svc = LLMService(
        Settings(llm_provider="bedrock", llm_model="anthropic.claude-3-sonnet")
    )
    with patch.dict(
        sys.modules,
        {
            "boto3": fake_boto3,
            "botocore": fake_botocore,
            "botocore.config": fake_botocore_config,
        },
    ):
        res_bedrock = asyncio.run(bedrock_svc.test_connection())
    assert res_bedrock["ok"] is True
    fake_boto3.client.assert_called_once()
    assert bedrock_client.converse.call_args.kwargs["modelId"] == "anthropic.claude-3-sonnet"


def test_settings_provider_fields_override_env_for_vertex_and_azure(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "env-project")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    monkeypatch.setenv("AZURE_API_VERSION", "2024-06-01")

    fake_creds = MagicMock(token="ya29.ui-token")
    fake_google_auth = types.ModuleType("google.auth")
    fake_google_auth.default = MagicMock(return_value=(fake_creds, "adc-project"))
    fake_requests = types.ModuleType("google.auth.transport.requests")
    fake_requests.Request = MagicMock()
    fake_transport = types.ModuleType("google.auth.transport")
    fake_transport.requests = fake_requests
    fake_google = types.ModuleType("google")
    fake_google.auth = fake_google_auth

    mock_post = AsyncMock(return_value=_make_gemini_json("OK"))
    vertex_svc = LLMService(
        Settings(
            llm_provider="vertex_ai",
            llm_model="gemini-3.8-flash",
            vertexai_project="ui-entered-project",
            vertexai_location="global",
        )
    )
    with patch.dict(
        sys.modules,
        {
            "google": fake_google,
            "google.auth": fake_google_auth,
            "google.auth.transport": fake_transport,
            "google.auth.transport.requests": fake_requests,
        },
    ):
        with patch("backend.services.llm._post_json", new=mock_post):
            assert asyncio.run(vertex_svc.test_connection())["ok"] is True
    assert mock_post.call_args.args[0] == (
        "https://aiplatform.googleapis.com/v1/projects/ui-entered-project"
        "/locations/global/publishers/google/models/gemini-3.8-flash:generateContent"
    )

    azure_mock_post = AsyncMock(return_value=_make_openai_json("OK"))
    azure_svc = LLMService(
        Settings(
            llm_provider="azure",
            llm_model="deploy-1",
            llm_api_key="az-key",
            llm_base_url="https://demo.openai.azure.com",
            azure_api_version="2025-01-01-preview",
        )
    )
    with patch("backend.services.llm._post_json", new=azure_mock_post):
        assert asyncio.run(azure_svc.test_connection())["ok"] is True
    assert azure_mock_post.call_args.kwargs["params"] == {"api-version": "2025-01-01-preview"}




