import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  CloudOff,
  Code2,
  Eye,
  FileText,
  ListChecks,
  Send,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import {
  api,
  ApiError,
  clearCandidateToken,
  setCandidateToken,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  AnswerItem,
  CandidateQuestion,
  FinishResponse,
  OpenBookPolicy,
  PublicTemplateMetadata,
  QuestionDifficulty,
  QuestionFormat,
} from '../../types/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Modal,
  Spinner,
  useToast,
} from '../../components/ui';
import { LoginCard, type LoginSubmission } from '../../components/candidate/LoginCard';
import { McqInput } from '../../components/candidate/McqInput';
import { MarkdownAnswerEditor } from '../../components/candidate/MarkdownAnswerEditor';
import { CodeAnswerEditor } from '../../components/candidate/CodeAnswerEditor';
import {
  hasNotebookContent,
  NotebookWorkspace,
  parseNotebookValue,
  serializeNotebookCells,
  type InstalledPackageInfo,
} from '../../components/candidate/NotebookWorkspace';
import { ResearchPanel } from '../../components/candidate/ResearchPanel';
import { CompletionCard } from '../../components/candidate/CompletionCard';

export interface CandidateFlowProps {
  /** Optional slug override (defaults to route param `:slug`). */
  slug?: string;
  /** When true, skips login and never mutates backend submissions. */
  previewMode?: boolean;
  /** Template metadata used in previewMode. */
  previewTemplate?: PublicTemplateMetadata;
  /** Resolved candidate questions used in previewMode. */
  previewQuestions?: CandidateQuestion[];
  /** Python version badge label for previewMode. */
  previewPythonVersion?: string;
  /** Callback when interviewer exits previewMode. */
  onExitPreview?: () => void;
}

type Stage = 'loading' | 'error' | 'login' | 'assessment' | 'submitting' | 'completed';
type SyncState = 'idle' | 'saving' | 'saved' | 'local_only';

interface PersistedDraft {
  slug: string;
  sessionToken: string;
  candidateName: string;
  candidateEmail: string | null;
  template: PublicTemplateMetadata;
  questions: CandidateQuestion[];
  pythonVersion: string;
  startedAtMs: number;
  endsAtMs: number;
  currentIndex: number;
  answers: Record<number, unknown>;
  installedPackages?: InstalledPackageInfo[];
}

const DRAFT_KEY_PREFIX = 'uip_candidate_draft_v1_';
const WARNING_THRESHOLD_SECONDS = 300; // 5 minutes

function draftKey(slug: string): string {
  return `${DRAFT_KEY_PREFIX}${slug}`;
}

function readDraft(slug: string): PersistedDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
    if (
      !parsed ||
      parsed.slug !== slug ||
      typeof parsed.sessionToken !== 'string' ||
      !parsed.sessionToken ||
      !parsed.template ||
      !Array.isArray(parsed.questions) ||
      typeof parsed.endsAtMs !== 'number'
    ) {
      return null;
    }
    return {
      slug: parsed.slug,
      sessionToken: parsed.sessionToken,
      candidateName: String(parsed.candidateName || 'Candidate'),
      candidateEmail: parsed.candidateEmail ?? null,
      template: parsed.template,
      questions: parsed.questions,
      pythonVersion: parsed.pythonVersion || '3.11',
      startedAtMs: typeof parsed.startedAtMs === 'number' ? parsed.startedAtMs : Date.now(),
      endsAtMs: parsed.endsAtMs,
      currentIndex:
        typeof parsed.currentIndex === 'number' &&
        parsed.currentIndex >= 0 &&
        parsed.currentIndex < parsed.questions.length
          ? parsed.currentIndex
          : 0,
      answers:
        parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : {},
      installedPackages: Array.isArray(parsed.installedPackages)
        ? parsed.installedPackages
        : [],
    };
  } catch {
    return null;
  }
}

function stripImagesFromAnswers(
  answers: Record<number, unknown>,
  questions: CandidateQuestion[]
): Record<number, unknown> {
  const notebookIds = new Set(
    questions.filter((q) => q.format === 'notebook').map((q) => q.id)
  );
  const slim: Record<number, unknown> = {};
  for (const [key, val] of Object.entries(answers)) {
    const qid = Number(key);
    if (notebookIds.has(qid) && typeof val === 'string') {
      const cells = parseNotebookValue(val, null).map((c) => ({
        ...c,
        image_png_base64: null,
      }));
      slim[qid] = serializeNotebookCells(cells);
    } else {
      slim[qid] = val;
    }
  }
  return slim;
}

function writeDraft(draft: PersistedDraft): void {
  const key = draftKey(draft.slug);
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Fallback if large plot PNGs exceeded localStorage quota
    try {
      const slimDraft: PersistedDraft = {
        ...draft,
        answers: stripImagesFromAnswers(draft.answers, draft.questions),
      };
      window.localStorage.setItem(key, JSON.stringify(slimDraft));
    } catch {
      // Ignore storage quota errors in restricted browsing modes
    }
  }
}

function clearDraft(slug: string): void {
  try {
    window.localStorage.removeItem(draftKey(slug));
  } catch {
    // Ignore
  }
}

function buildInitialAnswers(questions: CandidateQuestion[]): Record<number, unknown> {
  const initial: Record<number, unknown> = {};
  for (const q of questions) {
    if (q.format === 'mcq') {
      initial[q.id] = [];
    } else if (q.format === 'code') {
      initial[q.id] = q.starter_code ?? '';
    } else if (q.format === 'notebook') {
      initial[q.id] = serializeNotebookCells(parseNotebookValue(null, q.starter_code));
    } else {
      initial[q.id] = '';
    }
  }
  return initial;
}

function normalizeMcqValue(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return [raw];
  }
  return [];
}

function isQuestionAnswered(question: CandidateQuestion, rawAnswer: unknown): boolean {
  if (question.format === 'mcq') {
    return normalizeMcqValue(rawAnswer).length > 0;
  }
  if (question.format === 'notebook') {
    if (!hasNotebookContent(rawAnswer)) return false;
    // Consider answered if modified from starter or has executed outputs
    const cells = parseNotebookValue(
      typeof rawAnswer === 'string' ? rawAnswer : null,
      null
    );
    const hasExecuted = cells.some(
      (c) => c.execution_count !== null || Boolean(c.stdout || c.html || c.image_png_base64)
    );
    if (hasExecuted) return true;
    const starterSerialized = question.starter_code
      ? parseNotebookValue(null, question.starter_code)
          .map((c) => c.source.trim())
          .join('\n')
      : '';
    const currentText = cells.map((c) => c.source.trim()).join('\n');
    return currentText.length > 0 && currentText !== starterSerialized;
  }
  if (question.format === 'code') {
    const str = typeof rawAnswer === 'string' ? rawAnswer.trim() : '';
    const starter = (question.starter_code ?? '').trim();
    return str.length > 0 && str !== starter;
  }
  return typeof rawAnswer === 'string' && rawAnswer.trim().length > 0;
}

function isOpenBookAllowedForQuestion(
  policy: OpenBookPolicy,
  question: CandidateQuestion
): boolean {
  if (policy === 'none') return false;
  if (policy === 'all') return true;
  if (policy === 'medium_hard') {
    return question.difficulty === 'medium' || question.difficulty === 'hard';
  }
  return Boolean(question.open_book_allowed);
}

function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function formatBadgeMeta(format: QuestionFormat): {
  label: string;
  icon: typeof Code2;
  variant: 'indigo' | 'cyan' | 'emerald' | 'amber';
} {
  switch (format) {
    case 'mcq':
      return { label: 'Multiple Choice', icon: ListChecks, variant: 'indigo' };
    case 'text':
      return { label: 'Long-Form Text', icon: FileText, variant: 'emerald' };
    case 'code':
      return { label: 'Code', icon: Code2, variant: 'cyan' };
    case 'notebook':
      return { label: 'Python Notebook', icon: Terminal, variant: 'amber' };
  }
}

function difficultyVariant(difficulty: QuestionDifficulty): 'emerald' | 'amber' | 'rose' {
  switch (difficulty) {
    case 'easy':
      return 'emerald';
    case 'medium':
      return 'amber';
    case 'hard':
      return 'rose';
  }
}

const FINALIZE_STEPS = [
  'Backing up your submitted answers & notebook cells',
  'Evaluating responses against interviewer rubrics',
  'Generating PDF report & delivering to hiring team',
];

export function CandidateFlow({
  slug: slugProp,
  previewMode = false,
  previewTemplate,
  previewQuestions,
  previewPythonVersion = '3.11',
  onExitPreview,
}: CandidateFlowProps = {}) {
  const { slug: routeSlug } = useParams<{ slug?: string }>();
  const effectiveSlugParam = slugProp ?? routeSlug;
  const { toast } = useToast();

  // Stage & core assessment state
  const [stage, setStage] = useState<Stage>(() =>
    previewMode && previewTemplate ? 'assessment' : 'loading'
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // Admin Studio is a local-only surface: in a candidate deployment the
  // portal must not link to it. The mode comes from the backend /health
  // endpoint; until it answers, assume local so nothing flickers away.
  const [appMode, setAppMode] = useState<'local' | 'candidate'>('local');
  useEffect(() => {
    if (previewMode) return;
    let live = true;
    api.public
      .getHealth()
      .then((health) => {
        if (live) setAppMode(health.mode);
      })
      .catch(() => {
        // Keep the local default when the backend cannot be reached.
      });
    return () => {
      live = false;
    };
  }, [previewMode]);
  const [template, setTemplate] = useState<PublicTemplateMetadata | null>(
    () => previewTemplate ?? null
  );
  const [questions, setQuestions] = useState<CandidateQuestion[]>(
    () => previewQuestions ?? []
  );
  const [sessionToken, setSessionToken] = useState<string>('');
  const [candidateName, setCandidateName] = useState<string>(
    previewMode ? 'Preview Candidate' : ''
  );
  const [candidateEmail, setCandidateEmail] = useState<string | null>(null);
  const [pythonVersion, setPythonVersion] = useState<string>(previewPythonVersion);

  // Answers & navigation
  const [answers, setAnswers] = useState<Record<number, unknown>>(() =>
    previewMode && previewQuestions ? buildInitialAnswers(previewQuestions) : {}
  );
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [installedPackages, setInstalledPackages] = useState<InstalledPackageInfo[]>([]);

  // Timer & session timing
  const [startedAtMs, setStartedAtMs] = useState<number>(() => Date.now());
  const [endsAtMs, setEndsAtMs] = useState<number>(() =>
    previewTemplate
      ? Date.now() + previewTemplate.timer_minutes * 60 * 1000
      : Date.now() + 45 * 60 * 1000
  );
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() =>
    previewTemplate ? previewTemplate.timer_minutes * 60 : 45 * 60
  );
  const warnedFiveMinRef = useRef(false);
  const autoSubmittedRef = useRef(false);

  // Login & submit UI states
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submitModalOpen, setSubmitModalOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorStaleSession, setSubmitErrorStaleSession] = useState(false);
  const [finalizeStepIndex, setFinalizeStepIndex] = useState(0);
  const [completionData, setCompletionData] = useState<{
    receipt: FinishResponse;
    durationSeconds: number;
    answeredCount: number;
  } | null>(null);

  // Research panel & sync status
  const [researchOpen, setResearchOpen] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>('idle');

  // Refs for latest state inside timers/callbacks
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const templateRef = useRef(template);
  templateRef.current = template;
  const sessionTokenRef = useRef(sessionToken);
  sessionTokenRef.current = sessionToken;
  const stageRef = useRef(stage);
  stageRef.current = stage;

  // Keep preview props synchronized if Admin Studio updates previewTemplate/previewQuestions
  useEffect(() => {
    if (!previewMode || !previewTemplate) return;
    const qs = previewQuestions ?? [];
    setTemplate(previewTemplate);
    setQuestions(qs);
    setCandidateName('Preview Candidate');
    setPythonVersion(previewPythonVersion);
    setAnswers(buildInitialAnswers(qs));
    setCurrentIndex(0);
    setInstalledPackages([]);
    const now = Date.now();
    const durationSec = Math.max(1, previewTemplate.timer_minutes) * 60;
    setStartedAtMs(now);
    setEndsAtMs(now + durationSec * 1000);
    setRemainingSeconds(durationSec);
    warnedFiveMinRef.current = false;
    autoSubmittedRef.current = false;
    setCompletionData(null);
    setStage('assessment');
  }, [previewMode, previewTemplate, previewQuestions, previewPythonVersion]);

  // Helper: serialize answers map into AnswerItem[] for API
  const buildAnswerPayload = useCallback((): AnswerItem[] => {
    const qs = questionsRef.current;
    const ans = answersRef.current;
    return qs.map((q) => ({
      question_id: q.id,
      answer: ans[q.id] ?? (q.format === 'mcq' ? [] : ''),
    }));
  }, []);

  // Finalize & Submit handler (called on manual submit or timer expiry)
  const submitAssessment = useCallback(
    async (isAutoSubmit: boolean) => {
      if (stageRef.current === 'submitting' || stageRef.current === 'completed') {
        return;
      }

      setSubmitModalOpen(false);
      setSubmitError(null);
      setSubmitErrorStaleSession(false);

      const tpl = templateRef.current;
      const qs = questionsRef.current;
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
      const answeredCount = qs.filter((q) =>
        isQuestionAnswered(q, answersRef.current[q.id])
      ).length;

      if (previewMode) {
        setCompletionData({
          receipt: {
            status: 'submitted',
            submission_id: `preview-${Date.now().toString(36)}`,
            candidate_name: candidateName || 'Preview Candidate',
            submitted_at: new Date().toISOString(),
            message:
              'Preview complete! No real submission was written, graded, or delivered.',
          },
          durationSeconds: elapsedSeconds,
          answeredCount,
        });
        setStage('completed');
        return;
      }

      setStage('submitting');
      setFinalizeStepIndex(0);

      try {
        const res = await api.public.finish({
          session_token: sessionTokenRef.current,
          candidate_name: candidateName,
          candidate_email: candidateEmail,
          slug: tpl?.slug ?? effectiveSlugParam ?? null,
          answers: buildAnswerPayload(),
          duration_seconds: elapsedSeconds,
        });

        if (tpl?.slug) {
          clearDraft(tpl.slug);
        }
        clearCandidateToken();

        setCompletionData({
          receipt: res,
          durationSeconds: elapsedSeconds,
          answeredCount,
        });
        setStage('completed');

        if (isAutoSubmit) {
          toast({
            title: 'Time expired — assessment submitted',
            description: 'Your saved answers were automatically submitted.',
            variant: 'info',
          });
        }
      } catch (err: unknown) {
        const isStaleSession =
          err instanceof ApiError && (err.status === 401 || err.status === 404);
        const detail =
          err instanceof ApiError
            ? err.detail
            : 'Connection interrupted while submitting. Your draft is safely preserved locally — please retry.';
        setSubmitError(detail);
        setSubmitErrorStaleSession(isStaleSession);
        setStage('assessment');
        // Keep autoSubmittedRef.current as-is so an expired timer never triggers an infinite retry loop.
        toast({
          title: isStaleSession ? 'Session expired or unavailable' : 'Submission did not complete',
          description: detail,
          variant: 'error',
          durationMs: 7000,
        });
      }
    },
    [
      previewMode,
      startedAtMs,
      candidateName,
      candidateEmail,
      effectiveSlugParam,
      buildAnswerPayload,
      toast,
    ]
  );

  const submitAssessmentRef = useRef(submitAssessment);
  submitAssessmentRef.current = submitAssessment;

  // Initial template load + localStorage session resume (non-previewMode)
  useEffect(() => {
    if (previewMode) return;
    let cancelled = false;
    setStage('loading');
    setLoadError(null);

    const load = effectiveSlugParam
      ? api.public.getTemplateBySlug(effectiveSlugParam)
      : api.public.getDefaultTemplate();

    load
      .then((tpl) => {
        if (cancelled) return;
        setTemplate(tpl);
        document.title = `${tpl.name} · BigBank - An open source interview taking platform`;

        const saved = readDraft(tpl.slug);
        if (saved) {
          setSessionToken(saved.sessionToken);
          setCandidateToken(saved.sessionToken);
          setCandidateName(saved.candidateName);
          setCandidateEmail(saved.candidateEmail);
          setQuestions(saved.questions);
          setPythonVersion(saved.pythonVersion);
          setStartedAtMs(saved.startedAtMs);
          setEndsAtMs(saved.endsAtMs);
          setCurrentIndex(saved.currentIndex);
          setAnswers(saved.answers);
          setInstalledPackages(saved.installedPackages ?? []);

          const secsLeft = Math.max(0, Math.ceil((saved.endsAtMs - Date.now()) / 1000));
          setRemainingSeconds(secsLeft);
          if (secsLeft <= WARNING_THRESHOLD_SECONDS) {
            warnedFiveMinRef.current = true;
          }
          setStage('assessment');
          toast({
            title: 'Session restored',
            description: `Resumed your saved progress for ${tpl.name}.`,
            variant: 'info',
          });

          if (secsLeft <= 0 && !autoSubmittedRef.current) {
            autoSubmittedRef.current = true;
            window.setTimeout(() => {
              void submitAssessmentRef.current(true);
            }, 250);
          }
        } else {
          setStage('login');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError
            ? err.detail
            : 'Unable to load assessment details. Please check your link or try again.'
        );
        setStage('error');
      });

    return () => {
      cancelled = true;
    };
  }, [previewMode, effectiveSlugParam, toast]);

  // Animate finalizing step progress while synchronous /api/public/finish runs
  useEffect(() => {
    if (stage !== 'submitting') return;
    const t1 = window.setTimeout(() => setFinalizeStepIndex(1), 1600);
    const t2 = window.setTimeout(() => setFinalizeStepIndex(2), 4200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [stage]);

  // Hard countdown timer during assessment
  useEffect(() => {
    if (stage !== 'assessment') return;

    const tick = () => {
      const secsLeft = Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
      setRemainingSeconds(secsLeft);

      if (secsLeft > 0 && secsLeft <= WARNING_THRESHOLD_SECONDS && !warnedFiveMinRef.current) {
        warnedFiveMinRef.current = true;
        toast({
          title: '5 minutes remaining',
          description: 'Please wrap up your work. Your assessment will auto-submit at 00:00.',
          variant: 'warning',
          durationMs: 6500,
        });
      }

      if (secsLeft <= 0 && !autoSubmittedRef.current) {
        autoSubmittedRef.current = true;
        if (previewMode) {
          toast({
            title: 'Preview timer reached 00:00',
            description: 'In a live session, the assessment would auto-submit now.',
            variant: 'warning',
          });
        } else {
          void submitAssessmentRef.current(true);
        }
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [stage, endsAtMs, previewMode, toast]);

  // Persist draft continuously to localStorage
  useEffect(() => {
    if (previewMode || stage !== 'assessment' || !template || !sessionToken) return;
    const timer = window.setTimeout(() => {
      writeDraft({
        slug: template.slug,
        sessionToken,
        candidateName,
        candidateEmail,
        template,
        questions,
        pythonVersion,
        startedAtMs,
        endsAtMs,
        currentIndex,
        answers,
        installedPackages,
      });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [
    previewMode,
    stage,
    template,
    sessionToken,
    candidateName,
    candidateEmail,
    questions,
    pythonVersion,
    startedAtMs,
    endsAtMs,
    currentIndex,
    answers,
    installedPackages,
  ]);

  // Debounced server sync via /api/public/progress
  const syncProgressToServer = useCallback(async () => {
    if (previewMode || stageRef.current !== 'assessment' || !sessionTokenRef.current) {
      return;
    }
    setSyncState('saving');
    try {
      await api.public.saveProgress({
        session_token: sessionTokenRef.current,
        answers: buildAnswerPayload(),
        candidate_name: candidateName,
      });
      setSyncState('saved');
    } catch {
      setSyncState('local_only');
    }
  }, [previewMode, buildAnswerPayload, candidateName]);

  useEffect(() => {
    if (previewMode || stage !== 'assessment' || !sessionToken) return;
    const timer = window.setTimeout(() => {
      void syncProgressToServer();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [previewMode, stage, sessionToken, answers, syncProgressToServer]);

  // Close research panel automatically if switching to a question where open-book isn't allowed
  const currentQuestion = questions[currentIndex] ?? null;
  const openBookAllowed = useMemo(() => {
    if (!template || !currentQuestion) return false;
    return isOpenBookAllowedForQuestion(template.open_book_policy, currentQuestion);
  }, [template, currentQuestion]);

  useEffect(() => {
    if (!openBookAllowed && researchOpen) {
      setResearchOpen(false);
    }
  }, [openBookAllowed, researchOpen]);

  // Login submit handler
  const handleLogin = async ({
    candidateName: name,
    candidateEmail: email,
    accessCode,
  }: LoginSubmission) => {
    setLoginLoading(true);
    setLoginError(null);

    try {
      const res = await api.public.login({
        candidate_name: name,
        candidate_email: email || null,
        access_code: accessCode,
        slug: template?.slug ?? effectiveSlugParam ?? null,
      });

      const now = Date.now();
      const durationSeconds = Math.max(1, res.template.timer_minutes) * 60;
      const initialAnswers = buildInitialAnswers(res.questions);

      setSessionToken(res.session_token);
      setCandidateToken(res.session_token);
      setCandidateName(res.candidate_name);
      setCandidateEmail(res.candidate_email);
      setTemplate(res.template);
      setQuestions(res.questions);
      setPythonVersion(res.python_version || '3.11');
      setAnswers(initialAnswers);
      setCurrentIndex(0);
      setInstalledPackages([]);
      setStartedAtMs(now);
      setEndsAtMs(now + durationSeconds * 1000);
      setRemainingSeconds(durationSeconds);
      warnedFiveMinRef.current = false;
      autoSubmittedRef.current = false;
      setSyncState('saved');

      writeDraft({
        slug: res.template.slug,
        sessionToken: res.session_token,
        candidateName: res.candidate_name,
        candidateEmail: res.candidate_email,
        template: res.template,
        questions: res.questions,
        pythonVersion: res.python_version || '3.11',
        startedAtMs: now,
        endsAtMs: now + durationSeconds * 1000,
        currentIndex: 0,
        answers: initialAnswers,
        installedPackages: [],
      });

      setStage('assessment');
    } catch (err: unknown) {
      setLoginError(
        err instanceof ApiError
          ? err.detail
          : 'Unable to start assessment. Please verify your access code and try again.'
      );
    } finally {
      setLoginLoading(false);
    }
  };

  const handleResetStaleSession = useCallback(() => {
    const slug = templateRef.current?.slug ?? effectiveSlugParam;
    if (slug) {
      clearDraft(slug);
    }
    clearCandidateToken();
    setSessionToken('');
    setAnswers({});
    setQuestions([]);
    setInstalledPackages([]);
    setSubmitError(null);
    setSubmitErrorStaleSession(false);
    setLoginError(null);
    warnedFiveMinRef.current = false;
    autoSubmittedRef.current = false;
    setStage('login');
  }, [effectiveSlugParam]);

  const handleRestartPreview = () => {
    if (!previewMode || !template) return;
    const qs = previewQuestions ?? questions;
    setAnswers(buildInitialAnswers(qs));
    setCurrentIndex(0);
    const now = Date.now();
    const durationSec = Math.max(1, template.timer_minutes) * 60;
    setStartedAtMs(now);
    setEndsAtMs(now + durationSec * 1000);
    setRemainingSeconds(durationSec);
    warnedFiveMinRef.current = false;
    autoSubmittedRef.current = false;
    setCompletionData(null);
    setStage('assessment');
  };

  const handleAnswerChange = useCallback((questionId: number, nextValue: unknown) => {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: nextValue,
    }));
  }, []);

  const navigateToQuestion = (index: number) => {
    if (index < 0 || index >= questions.length || index === currentIndex) return;
    setCurrentIndex(index);
    if (!previewMode) {
      void syncProgressToServer();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Answered summary metrics
  const answeredStatusList = useMemo(
    () => questions.map((q) => isQuestionAnswered(q, answers[q.id])),
    [questions, answers]
  );
  const answeredCount = useMemo(
    () => answeredStatusList.filter(Boolean).length,
    [answeredStatusList]
  );
  const progressPct =
    questions.length > 0 ? Math.round((answeredCount / questions.length) * 100) : 0;

  const isLowTime = remainingSeconds <= WARNING_THRESHOLD_SECONDS;
  const isCriticalTime = remainingSeconds <= 60;

  // -------------------------------------------------------------------------
  // Render: Loading, Error, Login, Submitting, Completed
  // -------------------------------------------------------------------------

  if (stage === 'loading' || stage === 'error' || stage === 'login' || stage === 'completed') {
    return (
      <div className="min-h-screen bg-surface-0 text-slate-100 flex flex-col">
        <header className="border-b border-slate-800/80 bg-surface-1/75 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 text-surface-0 shadow-glow-indigo">
                <Terminal className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold tracking-tight text-slate-100">
                  {template?.app_title ?? 'BigBank'}
                </span>
                <span className="text-[11px] font-medium text-slate-400">
                  BigBank - Interview Platform
                </span>
              </div>
            </div>

            {previewMode && onExitPreview ? (
              <Button variant="secondary" size="sm" onClick={onExitPreview}>
                Exit Preview
              </Button>
            ) : appMode !== 'candidate' ? (
              <Link
                to="/admin"
                className="text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors focus-ring rounded-md px-2 py-1"
              >
                Admin Studio
              </Link>
            ) : null}
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-10">
          {stage === 'loading' && (
            <Card className="w-full max-w-md">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-14">
                <Spinner size="lg" label="Loading assessment" />
                <p className="text-sm text-slate-400">Loading assessment details…</p>
              </CardContent>
            </Card>
          )}

          {stage === 'error' && (
            <Card className="w-full max-w-lg">
              <CardContent className="space-y-4 py-8">
                <Alert variant="error" title="Assessment Unavailable">
                  {loadError ?? 'The requested assessment could not be loaded.'}
                </Alert>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.location.reload()}
                  >
                    Retry
                  </Button>
                  {appMode !== 'candidate' && (
                    <Link to="/admin">
                      <Button variant="outline" size="sm">
                        Admin Studio
                      </Button>
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {stage === 'login' && template && (
            <LoginCard
              template={template}
              loading={loginLoading}
              error={loginError}
              onSubmit={(payload) => void handleLogin(payload)}
            />
          )}

          {stage === 'completed' && completionData && template && (
            <CompletionCard
              candidateName={completionData.receipt.candidate_name}
              templateName={template.name}
              roleTitle={template.role_title}
              submissionId={completionData.receipt.submission_id}
              submittedAt={completionData.receipt.submitted_at}
              message={completionData.receipt.message}
              answeredCount={completionData.answeredCount}
              totalQuestions={questions.length}
              durationSeconds={completionData.durationSeconds}
              previewMode={previewMode}
              onRestartPreview={handleRestartPreview}
              onExitPreview={onExitPreview}
            />
          )}
        </main>
      </div>
    );
  }

  if (stage === 'submitting') {
    return (
      <div className="min-h-screen bg-surface-0 text-slate-100 flex items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg overflow-hidden animate-fade-in">
          <div className="h-1.5 w-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 animate-pulse" />
          <CardContent className="space-y-6 p-8">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
                <Spinner size="lg" label="Finalizing submission" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                Submitting &amp; Finalizing Your Assessment…
              </h1>
              <p className="text-xs leading-relaxed text-slate-400 max-w-sm">
                Please keep this tab open while we securely back up your work, evaluate your
                responses, and deliver your assessment report.
              </p>
            </div>

            <div className="space-y-2.5 rounded-xl border border-slate-800/90 bg-surface-0/70 p-4">
              {FINALIZE_STEPS.map((label, idx) => {
                const done = idx < finalizeStepIndex;
                const active = idx === finalizeStepIndex;
                return (
                  <div key={label} className="flex items-center gap-3 text-xs">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                        done
                          ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                          : active
                            ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-300'
                            : 'border-slate-700 bg-slate-800/70 text-slate-500'
                      )}
                    >
                      {done ? (
                        <Check className="h-3 w-3" />
                      ) : active ? (
                        <Spinner size="xs" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
                      )}
                    </span>
                    <span
                      className={cn(
                        done
                          ? 'text-emerald-300'
                          : active
                            ? 'text-slate-100 font-medium'
                            : 'text-slate-500'
                      )}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Active Assessment Workspace
  // -------------------------------------------------------------------------

  const fmtMeta = currentQuestion ? formatBadgeMeta(currentQuestion.format) : null;
  const FormatIcon = fmtMeta?.icon ?? FileText;
  const unansweredCount = questions.length - answeredCount;

  return (
    <div className="min-h-screen bg-surface-0 text-slate-100 flex flex-col">
      {/* Preview Banner (Admin Studio Live Preview) */}
      {previewMode && (
        <div className="border-b border-indigo-500/30 bg-indigo-500/15 px-4 py-2">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-indigo-200">
              <Eye className="h-4 w-4 text-indigo-400 shrink-0" aria-hidden="true" />
              <span className="font-semibold">Live Candidate Preview</span>
              <span className="text-indigo-300/80 hidden sm:inline">
                — Interactive experience without creating real submissions or mutating results.
              </span>
            </div>
            {onExitPreview && (
              <Button variant="secondary" size="sm" onClick={onExitPreview} className="h-7">
                Exit Preview
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Sticky Top Assessment Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-surface-1/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          {/* Left: Brand & Template Title */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 text-surface-0 shadow-glow-indigo">
              <Terminal className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold tracking-tight text-white">
                  {template?.name ?? 'BigBank - Interview Platform'}
                </h1>
                {template?.role_title && (
                  <Badge variant="indigo" size="sm" className="hidden md:inline-flex">
                    {template.role_title}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                {candidateName} · {answeredCount} of {questions.length} answered ({progressPct}%)
              </p>
            </div>
          </div>

          {/* Right: Timer, Open-Book Toggle, Submit */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Hard Countdown Timer */}
            <div
              role="timer"
              aria-live={isCriticalTime ? 'assertive' : 'off'}
              aria-label={`Time remaining: ${formatCountdown(remainingSeconds)}`}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-sm font-semibold tabular-nums transition-colors',
                isCriticalTime
                  ? 'border-rose-500/60 bg-rose-500/20 text-rose-200 animate-pulse'
                  : isLowTime
                    ? 'border-amber-500/50 bg-amber-500/15 text-amber-200'
                    : 'border-slate-700/90 bg-surface-0/90 text-slate-100'
              )}
            >
              <Clock
                className={cn(
                  'h-4 w-4',
                  isCriticalTime
                    ? 'text-rose-400'
                    : isLowTime
                      ? 'text-amber-400'
                      : 'text-indigo-400'
                )}
                aria-hidden="true"
              />
              <span>{formatCountdown(remainingSeconds)}</span>
            </div>

            {/* Open-Book Research Button */}
            {openBookAllowed && (
              <Button
                variant={researchOpen ? 'primary' : 'outline'}
                size="sm"
                leftIcon={<BookOpen className="h-3.5 w-3.5" />}
                onClick={() => setResearchOpen((prev) => !prev)}
              >
                <span className="hidden sm:inline">Research</span>
              </Button>
            )}

            {/* Submit Assessment */}
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Send className="h-3.5 w-3.5" />}
              onClick={() => setSubmitModalOpen(true)}
            >
              Finish &amp; Submit
            </Button>
          </div>
        </div>

        {/* Continuous Progress Bar */}
        <div className="h-1 w-full bg-slate-900">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </header>

      {/* Low-Time Warning Strip */}
      {isLowTime && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5">
          <div className="mx-auto flex max-w-[1440px] items-center justify-center gap-2 text-xs text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              Less than 5 minutes remaining ({formatCountdown(remainingSeconds)}). Your assessment
              will automatically submit when the timer reaches 00:00.
            </span>
          </div>
        </div>
      )}

      {/* Question Navigation Strip */}
      <nav
        aria-label="Question navigation"
        className="border-b border-slate-800/80 bg-surface-1/50 px-4 py-2.5 sm:px-6"
      >
        <div className="mx-auto flex max-w-[1440px] items-center gap-2 overflow-x-auto custom-scrollbar">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500 shrink-0 mr-1">
            Questions
          </span>
          {questions.map((q, idx) => {
            const isCurrent = idx === currentIndex;
            const answered = answeredStatusList[idx];
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => navigateToQuestion(idx)}
                aria-current={isCurrent ? 'step' : undefined}
                title={`Q${idx + 1}: ${q.title || q.format.toUpperCase()} (${answered ? 'Answered' : 'Unanswered'})`}
                className={cn(
                  'inline-flex h-8 min-w-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 font-mono text-xs font-medium transition-all focus-ring',
                  isCurrent
                    ? 'border-indigo-500 bg-indigo-600/25 text-white shadow-glow-indigo'
                    : answered
                      ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200 hover:border-emerald-500/60'
                      : 'border-slate-800 bg-surface-0/70 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                )}
              >
                <span>{idx + 1}</span>
                {answered && (
                  <CheckCircle2
                    className={cn(
                      'h-3 w-3',
                      isCurrent ? 'text-cyan-300' : 'text-emerald-400'
                    )}
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        {submitError && (
          <div className="mb-5">
            <Alert
              variant="error"
              title={
                submitErrorStaleSession
                  ? 'Session Expired or Unavailable'
                  : 'Submission Error — Your Draft Is Safe'
              }
              onDismiss={() => {
                setSubmitError(null);
                setSubmitErrorStaleSession(false);
              }}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void submitAssessment(false)}
                  >
                    Retry Submit
                  </Button>
                  {submitErrorStaleSession && !previewMode && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleResetStaleSession}
                    >
                      Clear Draft &amp; Return to Login
                    </Button>
                  )}
                </div>
              }
            >
              {submitError}
              {submitErrorStaleSession && !previewMode && (
                <p className="mt-1 text-[11px] opacity-85">
                  Your saved session is no longer valid on the server. Clear the stale draft to
                  return to the check-in screen and start fresh.
                </p>
              )}
            </Alert>
          </div>
        )}

        {questions.length === 0 ? (
          <Card className="mx-auto max-w-xl">
            <CardContent className="py-12 text-center space-y-3">
              <p className="text-base font-semibold text-slate-100">
                No questions in this template
              </p>
              <p className="text-xs text-slate-400">
                Add questions to this template in Admin Studio to preview or run an assessment.
              </p>
            </CardContent>
          </Card>
        ) : currentQuestion ? (
          <div
            className={cn(
              'grid gap-6 items-start',
              openBookAllowed && researchOpen
                ? 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px]'
                : 'grid-cols-1 max-w-5xl mx-auto'
            )}
          >
            {/* Left/Primary Question & Answer Column */}
            <div className="min-w-0 space-y-5">
              {/* Question Prompt Card */}
              <Card>
                <CardContent className="space-y-4 p-5 sm:p-6">
                  {/* Question Metadata Badges */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="slate" size="md" className="font-mono">
                        Question {currentIndex + 1} / {questions.length}
                      </Badge>
                      {fmtMeta && (
                        <Badge variant={fmtMeta.variant} size="md">
                          <FormatIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          {fmtMeta.label}
                        </Badge>
                      )}
                      <Badge
                        variant={difficultyVariant(currentQuestion.difficulty)}
                        size="md"
                        className="capitalize"
                      >
                        {currentQuestion.difficulty}
                      </Badge>
                      <Badge variant="default" size="md">
                        {currentQuestion.points} pts
                      </Badge>
                    </div>

                    {openBookAllowed && !researchOpen && (
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<BookOpen className="h-3.5 w-3.5 text-emerald-400" />}
                        onClick={() => setResearchOpen(true)}
                        className="text-xs text-emerald-300 hover:bg-emerald-500/10"
                      >
                        Open Research Panel
                      </Button>
                    )}
                  </div>

                  {/* Question Title */}
                  {currentQuestion.title && (
                    <h2 className="text-lg font-bold tracking-tight text-white sm:text-xl">
                      {currentQuestion.title}
                    </h2>
                  )}

                  {/* Question Markdown Prompt */}
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {currentQuestion.prompt}
                    </ReactMarkdown>
                  </div>

                  {/* Tags */}
                  {currentQuestion.tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-800/70">
                      {currentQuestion.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-slate-800/80 border border-slate-700/60 px-2 py-0.5 font-mono text-[11px] text-slate-300"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Format-Specific Answer Editor */}
              <section aria-label="Your answer" className="space-y-2">
                {currentQuestion.format === 'mcq' && (
                  <Card>
                    <CardContent className="p-5 sm:p-6">
                      <McqInput
                        questionId={currentQuestion.id}
                        options={currentQuestion.options}
                        multiSelect={currentQuestion.multi_select}
                        value={normalizeMcqValue(answers[currentQuestion.id])}
                        onChange={(indices) => handleAnswerChange(currentQuestion.id, indices)}
                      />
                    </CardContent>
                  </Card>
                )}

                {currentQuestion.format === 'text' && (
                  <MarkdownAnswerEditor
                    key={currentQuestion.id}
                    value={
                      typeof answers[currentQuestion.id] === 'string'
                        ? (answers[currentQuestion.id] as string)
                        : ''
                    }
                    onChange={(next) => handleAnswerChange(currentQuestion.id, next)}
                  />
                )}

                {currentQuestion.format === 'code' && (
                  <CodeAnswerEditor
                    key={currentQuestion.id}
                    value={
                      typeof answers[currentQuestion.id] === 'string'
                        ? (answers[currentQuestion.id] as string)
                        : currentQuestion.starter_code ?? ''
                    }
                    onChange={(next) => handleAnswerChange(currentQuestion.id, next)}
                    language={currentQuestion.code_language}
                    starterCode={currentQuestion.starter_code}
                  />
                )}

                {currentQuestion.format === 'notebook' && (
                  <NotebookWorkspace
                    key={currentQuestion.id}
                    value={
                      typeof answers[currentQuestion.id] === 'string'
                        ? (answers[currentQuestion.id] as string)
                        : ''
                    }
                    onChange={(serialized) =>
                      handleAnswerChange(currentQuestion.id, serialized)
                    }
                    starterCode={currentQuestion.starter_code}
                    sessionToken={sessionToken || undefined}
                    allowExecution={Boolean(
                      template?.allow_code_execution && currentQuestion.allow_execution
                    )}
                    allowPackageInstall={Boolean(template?.allow_package_install)}
                    pythonVersion={pythonVersion}
                    previewMode={previewMode}
                    installedPackages={installedPackages}
                    onPackageInstalled={(pkg) =>
                      setInstalledPackages((prev) =>
                        prev.some((p) => p.name.toLowerCase() === pkg.name.toLowerCase())
                          ? prev
                          : [...prev, pkg]
                      )
                    }
                  />
                )}
              </section>

              {/* Bottom Question Navigation Footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-surface-1/80 px-4 py-3">
                <Button
                  variant="secondary"
                  size="md"
                  disabled={currentIndex === 0}
                  leftIcon={<ArrowLeft className="h-4 w-4" />}
                  onClick={() => navigateToQuestion(currentIndex - 1)}
                >
                  Previous
                </Button>

                {/* Sync Status Indicator */}
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  {previewMode ? (
                    <>
                      <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                      <span>Preview mode (draft not persisted)</span>
                    </>
                  ) : syncState === 'saving' ? (
                    <>
                      <Spinner size="xs" />
                      <span>Syncing draft…</span>
                    </>
                  ) : syncState === 'local_only' ? (
                    <>
                      <CloudOff className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                      <span>Saved locally</span>
                    </>
                  ) : (
                    <>
                      <Cloud className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                      <span>Progress auto-saved</span>
                    </>
                  )}
                </div>

                {currentIndex < questions.length - 1 ? (
                  <Button
                    variant="primary"
                    size="md"
                    rightIcon={<ArrowRight className="h-4 w-4" />}
                    onClick={() => navigateToQuestion(currentIndex + 1)}
                  >
                    Next Question
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="md"
                    leftIcon={<Send className="h-4 w-4" />}
                    onClick={() => setSubmitModalOpen(true)}
                  >
                    Review &amp; Submit
                  </Button>
                )}
              </div>
            </div>

            {/* Right Sticky Research Panel (Desktop) */}
            {openBookAllowed && researchOpen && (
              <div className="xl:sticky xl:top-20 xl:h-[calc(100vh-6.5rem)]">
                <ResearchPanel
                  key={`research-${currentQuestion.id}`}
                  tags={currentQuestion.tags}
                  sessionToken={sessionToken || undefined}
                  previewMode={previewMode}
                  onClose={() => setResearchOpen(false)}
                />
              </div>
            )}
          </div>
        ) : null}
      </main>

      {/* Final Submit Confirmation Modal */}
      <Modal
        open={submitModalOpen}
        onClose={() => setSubmitModalOpen(false)}
        title={previewMode ? 'Finish Live Preview?' : 'Submit Your Assessment?'}
        description={
          previewMode
            ? 'Review your preview summary below. No real submission or report will be created.'
            : 'Once submitted, you will no longer be able to edit your answers.'
        }
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSubmitModalOpen(false)}>
              Continue Working
            </Button>
            <Button
              variant="primary"
              leftIcon={<Send className="h-4 w-4" />}
              onClick={() => void submitAssessment(false)}
            >
              {previewMode ? 'Complete Preview' : 'Confirm & Submit'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-800 bg-surface-0/75 p-3.5">
              <p className="text-xs text-slate-400">Answered</p>
              <p className="mt-1 text-xl font-bold text-emerald-300">
                {answeredCount}{' '}
                <span className="text-xs font-normal text-slate-400">
                  / {questions.length}
                </span>
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-surface-0/75 p-3.5">
              <p className="text-xs text-slate-400">Time Remaining</p>
              <p className="mt-1 font-mono text-xl font-bold text-slate-100">
                {formatCountdown(remainingSeconds)}
              </p>
            </div>
          </div>

          {unansweredCount > 0 && (
            <Alert variant="warning" title={`${unansweredCount} unanswered ${unansweredCount === 1 ? 'question' : 'questions'}`}>
              You still have unanswered items. You can jump back to any question before submitting:
              <div className="mt-2 flex flex-wrap gap-1.5">
                {questions.map((q, idx) =>
                  !answeredStatusList[idx] ? (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => {
                        setSubmitModalOpen(false);
                        navigateToQuestion(idx);
                      }}
                      className="rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
                    >
                      Q{idx + 1}
                    </button>
                  ) : null
                )}
              </div>
            </Alert>
          )}

          {unansweredCount === 0 && (
            <Alert variant="success" title="All questions answered">
              Every question has a recorded response. Click Confirm &amp; Submit to finalize.
            </Alert>
          )}

          {!previewMode && (
            <p className="text-xs text-slate-400">
              Finalizing evaluates your answers and generates the report synchronously, which may
              take a few seconds.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
