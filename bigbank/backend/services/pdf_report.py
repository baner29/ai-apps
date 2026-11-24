"""Role-agnostic PDF interview evaluation report generator using fpdf2."""

from __future__ import annotations

from typing import Any

from fpdf import FPDF
from fpdf.enums import XPos, YPos

from backend.services.llm import format_notebook_answer

_UNICODE_REPLACEMENTS: dict[str, str] = {
    "\u2014": " - ",  # em-dash
    "\u2013": "-",    # en-dash
    "\u2018": "'",    # left single quote
    "\u2019": "'",    # right single quote
    "\u201c": '"',    # left double quote
    "\u201d": '"',    # right double quote
    "\u2022": "-",    # bullet
    "\u2026": "...",  # ellipsis
    "\u00a0": " ",    # non-breaking space
    "\u2192": "->",   # right arrow
    "\u2190": "<-",   # left arrow
    "\u2264": "<=",   # <=
    "\u2265": ">=",   # >=
    "\u2260": "!=",   # !=
    "\u00b7": "*",    # middle dot
    "\t": "    ",
}


def _clean_text(text: Any) -> str:
    """Sanitize arbitrary text for core latin-1 PDF fonts."""
    if text is None:
        return ""
    cleaned = str(text).replace("\r\n", "\n").replace("\r", "\n")
    for src, dst in _UNICODE_REPLACEMENTS.items():
        cleaned = cleaned.replace(src, dst)
    return cleaned.encode("latin-1", "replace").decode("latin-1")


def _wrap_long_tokens(text: str, max_token_len: int = 80) -> str:
    """Break abnormally long unbroken tokens so fpdf2 multi_cell never overflows."""
    if not text:
        return ""
    wrapped_lines: list[str] = []
    for line in text.split("\n"):
        if len(line) <= max_token_len:
            wrapped_lines.append(line)
            continue
        tokens = line.split(" ")
        rebuilt: list[str] = []
        for token in tokens:
            if len(token) <= max_token_len:
                rebuilt.append(token)
            else:
                chunks = [
                    token[i : i + max_token_len]
                    for i in range(0, len(token), max_token_len)
                ]
                rebuilt.append("\n".join(chunks))
        wrapped_lines.append(" ".join(rebuilt))
    return "\n".join(wrapped_lines)


def _format_score(value: Any) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return "0"
    if num.is_integer():
        return str(int(num))
    return f"{num:.2f}".rstrip("0").rstrip(".")


def _format_duration(seconds: Any) -> str:
    try:
        total = max(0, int(round(float(seconds or 0))))
    except (TypeError, ValueError):
        total = 0
    mins, rem = divmod(total, 60)
    hours, mins = divmod(mins, 60)
    if hours > 0:
        return f"{hours}h {mins}m {rem}s"
    return f"{mins}m {rem}s"


def _resolve_correctness_pct(evaluation: dict[str, Any]) -> float:
    """Safely resolve numeric correctness percentage, falling back to score / max_points."""
    raw_pct = evaluation.get("correctness_pct")
    if raw_pct is not None and str(raw_pct).strip() != "":
        try:
            return float(raw_pct)
        except (TypeError, ValueError):
            pass
    try:
        score = float(evaluation.get("score") or 0)
        max_pts = float(evaluation.get("max_points") or 0)
        return (score / max_pts) * 100.0 if max_pts > 0 else 0.0
    except (TypeError, ValueError):
        return 0.0


class _InterviewReportPDF(FPDF):
    """Styled FPDF document carrying dynamic role and template metadata."""

    def __init__(self, role_title: str, template_name: str) -> None:
        super().__init__(orientation="P", unit="mm", format="A4")
        self.role_title = role_title.strip()
        self.template_name = template_name.strip()
        self.set_margins(15, 24, 15)
        self.set_auto_page_break(auto=True, margin=18)
        self.alias_nb_pages()

    def header(self) -> None:
        # Dark slate banner across top of every page
        self.set_fill_color(30, 41, 59)
        self.rect(0, 0, 210, 18, "F")

        self.set_y(4.5)
        self.set_x(15)
        self.set_font("Helvetica", "B", 12)
        self.set_text_color(255, 255, 255)
        self.cell(
            90,
            9,
            _clean_text("BigBank - Interview Platform"),
            border=0,
            align="L",
            new_x=XPos.RIGHT,
            new_y=YPos.TOP,
        )

        subtitle_parts = [p for p in (self.role_title, self.template_name) if p]
        subtitle = " | ".join(subtitle_parts)
        if subtitle:
            self.set_font("Helvetica", "", 9)
            self.set_text_color(203, 213, 225)
            self.cell(
                90,
                9,
                _clean_text(subtitle[:70]),
                border=0,
                align="R",
                new_x=XPos.LMARGIN,
                new_y=YPos.NEXT,
            )
        else:
            self.ln(9)

        self.set_y(24)

    def footer(self) -> None:
        self.set_y(-13)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(100, 116, 139)
        self.cell(
            0,
            8,
            _clean_text(f"Page {self.page_no()} of {{nb}}"),
            border=0,
            align="C",
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )

    def chapter_heading(self, title: str) -> None:
        self.set_x(self.l_margin)
        self.set_font("Helvetica", "B", 14)
        self.set_text_color(15, 23, 42)
        self.multi_cell(
            0,
            8,
            _wrap_long_tokens(_clean_text(title)),
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        # Subtle accent underline
        y = self.get_y()
        self.set_draw_color(59, 130, 246)
        self.set_line_width(0.6)
        self.line(self.l_margin, y, self.w - self.r_margin, y)
        self.set_line_width(0.2)
        self.ln(4)

    def section_heading(self, title: str, badge: str = "") -> None:
        self.set_x(self.l_margin)
        self.set_font("Helvetica", "B", 11)
        self.set_text_color(51, 65, 85)
        full_title = f"{title}   {badge}" if badge else title
        self.multi_cell(
            0,
            6.5,
            _wrap_long_tokens(_clean_text(full_title)),
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        self.ln(1)

    def body_text(self, text: str) -> None:
        self.set_x(self.l_margin)
        self.set_font("Helvetica", "", 10)
        self.set_text_color(30, 41, 59)
        self.multi_cell(
            0,
            5.5,
            _wrap_long_tokens(_clean_text(text)),
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        self.ln(3)

    def tinted_box(
        self,
        text: str,
        *,
        fill_color: tuple[int, int, int] = (241, 245, 249),
        border_color: tuple[int, int, int] = (203, 213, 225),
        monospace: bool = False,
    ) -> None:
        self.set_x(self.l_margin)
        self.set_fill_color(*fill_color)
        self.set_draw_color(*border_color)
        self.set_text_color(15, 23, 42)
        if monospace:
            self.set_font("Courier", "", 8.5)
            line_h = 4.8
            max_tok = 75
        else:
            self.set_font("Helvetica", "", 10)
            line_h = 5.5
            max_tok = 80
        self.multi_cell(
            0,
            line_h,
            _wrap_long_tokens(_clean_text(text), max_token_len=max_tok),
            border=1,
            fill=True,
            padding=2.5,
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        self.ln(3.5)

    def key_value_row(self, label: str, value: str) -> None:
        self.set_x(self.l_margin)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(51, 65, 85)
        label_text = _clean_text(f"{label}:")
        label_w = 50
        if self.get_string_width(label_text) <= label_w - 2:
            self.cell(
                label_w,
                6,
                label_text,
                border=0,
                align="L",
                new_x=XPos.RIGHT,
                new_y=YPos.TOP,
            )
            self.set_font("Helvetica", "", 10)
            self.set_text_color(15, 23, 42)
            self.multi_cell(
                0,
                6,
                _wrap_long_tokens(_clean_text(value), max_token_len=65),
                new_x=XPos.LMARGIN,
                new_y=YPos.NEXT,
            )
        else:
            self.multi_cell(
                0,
                5.5,
                _wrap_long_tokens(label_text, max_token_len=75),
                new_x=XPos.LMARGIN,
                new_y=YPos.NEXT,
            )
            self.set_x(self.l_margin + 4)
            self.set_font("Helvetica", "", 10)
            self.set_text_color(15, 23, 42)
            self.multi_cell(
                0,
                5.5,
                _wrap_long_tokens(_clean_text(value), max_token_len=72),
                new_x=XPos.LMARGIN,
                new_y=YPos.NEXT,
            )

    def bullet_list(self, items: list[str]) -> None:
        self.set_font("Helvetica", "", 9.5)
        self.set_text_color(30, 41, 59)
        for item in items:
            cleaned = _wrap_long_tokens(_clean_text(item), max_token_len=75)
            if not cleaned.strip():
                continue
            self.set_x(self.l_margin + 3)
            self.multi_cell(
                0,
                5.2,
                f"- {cleaned}",
                new_x=XPos.LMARGIN,
                new_y=YPos.NEXT,
            )
        self.ln(2.5)


def generate_interview_pdf(results: dict[str, Any]) -> bytes:
    """Render a role-agnostic, template-aware interview evaluation report as PDF bytes."""
    candidate_name = str(results.get("candidate_name") or "Unknown Candidate")
    candidate_email = str(results.get("candidate_email") or "").strip()
    role_title = str(results.get("role_title") or "Candidate Evaluation").strip()
    template_name = str(results.get("template_name") or "").strip()
    submitted_at = str(results.get("submitted_at") or "").strip()

    pdf = _InterviewReportPDF(role_title=role_title, template_name=template_name)
    pdf.add_page()

    # Cover / Candidate & Role Metadata
    pdf.chapter_heading(f"Candidate Evaluation: {candidate_name}")

    pdf.key_value_row("Target Role", role_title or "N/A")
    if template_name:
        pdf.key_value_row("Assessment Template", template_name)
    if candidate_email:
        pdf.key_value_row("Candidate Email", candidate_email)
    if submitted_at:
        pdf.key_value_row("Submitted At", submitted_at)

    answers: list[dict[str, Any]] = list(results.get("answers") or [])
    final_score = results.get("final_score", 0)
    max_score = results.get("max_score", 0)
    percentage = results.get("score_percentage")
    if percentage is None:
        try:
            f_val = float(final_score or 0)
            m_val = float(max_score or 0)
            percentage = round((f_val / m_val) * 100.0, 1) if m_val > 0 else 0.0
        except (TypeError, ValueError):
            percentage = 0.0

    total_q = results.get("total_questions", len(answers))
    attempted_q = results.get("attempted_questions", total_q)
    duration_str = _format_duration(results.get("duration_seconds", 0))

    pdf.ln(2)
    score_summary_text = (
        f"Final Score: {_format_score(final_score)} / {_format_score(max_score)} ({percentage}%)\n"
        f"Questions Attempted: {attempted_q} / {total_q}    |    Time Taken: {duration_str}"
    )
    pdf.tinted_box(
        score_summary_text,
        fill_color=(239, 246, 255),
        border_color=(147, 197, 253),
    )

    # AI / Panel Summary Section
    summary = results.get("summary") or {}
    if isinstance(summary, dict) and summary:
        pdf.chapter_heading("Evaluation Summary")

        overall = summary.get("overall_feedback") or summary.get("performance_feedback")
        if overall:
            pdf.section_heading("Overall Feedback")
            pdf.body_text(str(overall))

        strengths = summary.get("strengths")
        if strengths:
            pdf.section_heading("Strengths")
            pdf.tinted_box(
                str(strengths),
                fill_color=(236, 253, 245),
                border_color=(110, 231, 183),
            )

        areas = summary.get("areas_of_opportunity")
        if areas:
            pdf.section_heading("Areas of Opportunity")
            pdf.tinted_box(
                str(areas),
                fill_color=(255, 241, 242),
                border_color=(253, 164, 175),
            )

        dimensions = summary.get("dimensions")
        if isinstance(dimensions, dict) and dimensions:
            pdf.section_heading("Competency Dimensions")
            for dim_name, dim_val in dimensions.items():
                pdf.key_value_row(str(dim_name), str(dim_val or "N/A"))
            pdf.ln(3)

    # Per-Question Detail Pages
    for idx, answer in enumerate(answers, start=1):
        if not isinstance(answer, dict):
            continue
        pdf.add_page()

        q_format = str(
            answer.get("question_format") or answer.get("format") or "text"
        ).strip().lower()
        difficulty = str(answer.get("difficulty") or "medium").strip().capitalize()
        q_title = str(answer.get("title") or "").strip()
        heading_parts = [f"Question {idx}"]
        if q_title:
            heading_parts.append(f"- {q_title}")
        heading_parts.append(f"[{q_format.upper()}] ({difficulty})")
        pdf.chapter_heading(" ".join(heading_parts))

        prompt_text = str(answer.get("question_text") or answer.get("prompt") or "")
        pdf.section_heading("Prompt")
        pdf.tinted_box(
            prompt_text or "(No prompt recorded)",
            fill_color=(248, 250, 252),
            border_color=(203, 213, 225),
        )

        criteria = (
            answer.get("scoring_criteria")
            or answer.get("effective_rubric")
            or answer.get("evaluation_rubric")
        )
        if criteria and str(criteria).strip():
            pdf.section_heading("Evaluation Rubric / Scoring Criteria")
            pdf.body_text(str(criteria))

        expected = (
            answer.get("expected_answer")
            or answer.get("effective_expected_answer")
            or answer.get("correct_answer")
        )
        if expected and str(expected).strip():
            pdf.section_heading("Expected Answer / Reference Approach")
            pdf.body_text(str(expected))

        # Candidate Answer
        raw_cand_text = answer.get("candidate_answer_text")
        if raw_cand_text is None:
            raw_cand = answer.get("candidate_answer")
            if q_format == "notebook" and raw_cand:
                cand_display = format_notebook_answer(raw_cand)
            else:
                cand_display = str(raw_cand or "")
        else:
            cand_display = str(raw_cand_text)
            if (
                q_format == "notebook"
                and cand_display.lstrip().startswith("{")
                and '"cells"' in cand_display
            ):
                cand_display = format_notebook_answer(cand_display)

        is_unattempted = not cand_display.strip()
        pdf.section_heading("Candidate Answer")
        if is_unattempted:
            pdf.tinted_box(
                "(No answer provided)",
                fill_color=(255, 251, 235),
                border_color=(252, 211, 77),
            )
        else:
            is_code_like = q_format in {"code", "notebook"}
            pdf.tinted_box(
                cand_display,
                fill_color=(248, 250, 252) if is_code_like else (240, 249, 255),
                border_color=(186, 230, 253),
                monospace=is_code_like,
            )

        # Evaluation & Rubric Breakdown
        evaluation = answer.get("evaluation") or {}
        if isinstance(evaluation, dict) and evaluation:
            score_val = _format_score(evaluation.get("score", 0))
            max_pts_val = _format_score(evaluation.get("max_points", 0))
            pct = evaluation.get("correctness_pct")
            pct_str = f" ({pct}%)" if pct is not None and str(pct).strip() != "" else ""

            badge = ""
            if evaluation.get("manually_overridden"):
                badge = "[Manually Reviewed]"
            elif evaluation.get("needs_manual_review"):
                badge = "[Pending Manual Review]"

            pdf.section_heading(
                f"Evaluation Feedback - Score: {score_val} / {max_pts_val}{pct_str}",
                badge=badge,
            )

            rubric_items = evaluation.get("rubric_breakdown") or []
            if isinstance(rubric_items, list) and rubric_items:
                pdf.bullet_list([str(item) for item in rubric_items])

            feedback_text = str(evaluation.get("feedback") or "No feedback provided.")
            effective_pct = _resolve_correctness_pct(evaluation)
            if evaluation.get("needs_manual_review") and not evaluation.get("manually_overridden"):
                fb_fill, fb_border = (255, 251, 235), (252, 211, 77)
            elif effective_pct >= 60:
                fb_fill, fb_border = (236, 253, 245), (110, 231, 183)
            else:
                fb_fill, fb_border = (255, 241, 242), (253, 164, 175)

            pdf.tinted_box(
                feedback_text,
                fill_color=fb_fill,
                border_color=fb_border,
            )

    return bytes(pdf.output())
