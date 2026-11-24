import { useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowRight,
  BookOpen,
  Clock,
  Code2,
  Eye,
  EyeOff,
  FileQuestion,
  Lock,
  Package,
  ShieldCheck,
} from 'lucide-react';
import type { OpenBookPolicy, PublicTemplateMetadata } from '../../types/api';
import { Alert, Badge, Button, Card, CardContent, Input } from '../ui';

export interface LoginSubmission {
  candidateName: string;
  candidateEmail: string;
  accessCode: string;
}

export interface LoginCardProps {
  template: PublicTemplateMetadata;
  loading?: boolean;
  error?: string | null;
  initialName?: string;
  initialEmail?: string;
  onSubmit: (payload: LoginSubmission) => void;
}

function formatOpenBookPolicy(policy: OpenBookPolicy): { label: string; detail: string } {
  switch (policy) {
    case 'all':
      return { label: 'Open Book', detail: 'Web search enabled for all questions' };
    case 'medium_hard':
      return { label: 'Partial Open Book', detail: 'Web search on Medium & Hard questions' };
    case 'none':
    default:
      return { label: 'Closed Book', detail: 'No external search panel' };
  }
}

export function LoginCard({
  template,
  loading = false,
  error = null,
  initialName = '',
  initialEmail = '',
  onSubmit,
}: LoginCardProps) {
  const [candidateName, setCandidateName] = useState(initialName);
  const [candidateEmail, setCandidateEmail] = useState(initialEmail);
  const [accessCode, setAccessCode] = useState('');
  const [showCode, setShowCode] = useState(false);

  const [touched, setTouched] = useState<{
    name: boolean;
    email: boolean;
    code: boolean;
  }>({ name: false, email: false, code: false });

  const trimmedName = candidateName.trim();
  const trimmedEmail = candidateEmail.trim();
  const trimmedCode = accessCode.trim();

  const nameError =
    touched.name && !trimmedName ? 'Please enter your full name to continue.' : undefined;
  const emailError =
    touched.email &&
    trimmedEmail.length > 0 &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
      ? 'Please enter a valid email address.'
      : undefined;
  const codeError =
    touched.code && template.requires_access_code && !trimmedCode
      ? 'An access code is required for this assessment.'
      : undefined;

  const openBook = formatOpenBookPolicy(template.open_book_policy);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched({ name: true, email: true, code: true });

    if (!trimmedName) return;
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) return;
    if (template.requires_access_code && !trimmedCode) return;

    onSubmit({
      candidateName: trimmedName,
      candidateEmail: trimmedEmail,
      accessCode: trimmedCode,
    });
  };

  return (
    <Card className="w-full max-w-2xl overflow-hidden animate-fade-in">
      <div className="h-1.5 w-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-indigo-500" />
      <CardContent className="space-y-6 p-6 sm:p-8">
        {/* Header & Role Metadata */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="indigo" size="md">
              {template.role_title}
            </Badge>
            <Badge
              variant={template.open_book_policy === 'none' ? 'slate' : 'emerald'}
              size="md"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
              {openBook.label}
            </Badge>
            {template.requires_access_code && (
              <Badge variant="amber" size="md">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                Access Code Required
              </Badge>
            )}
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {template.name}
          </h1>

          {template.description && (
            <div className="markdown-body rounded-xl border border-slate-800/80 bg-surface-0/60 px-4 py-3.5 text-slate-300">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{template.description}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Assessment Overview Metrics */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Clock className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
              Time Limit
            </div>
            <p className="mt-1 text-lg font-semibold text-slate-100">
              {template.timer_minutes} minutes
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">Auto-submits when timer ends</p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <FileQuestion className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              Questions
            </div>
            <p className="mt-1 text-lg font-semibold text-slate-100">
              {template.question_count}{' '}
              <span className="text-xs font-normal text-slate-400">
                {template.question_count === 1 ? 'item' : 'items'}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">Navigate freely in any order</p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <BookOpen className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              Research Policy
            </div>
            <p className="mt-1 text-lg font-semibold text-slate-100">{openBook.label}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">{openBook.detail}</p>
          </div>
        </div>

        {/* Workspace Capabilities */}
        <div className="flex flex-wrap items-center gap-2">
          {template.allow_code_execution && (
            <Badge variant="cyan" size="md">
              <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
              Interactive Python Sandbox
            </Badge>
          )}
          {template.allow_code_execution && template.allow_package_install && (
            <Badge variant="indigo" size="md">
              <Package className="h-3.5 w-3.5" aria-hidden="true" />
              On-Demand PyPI Packages
            </Badge>
          )}
          <Badge variant="slate" size="md">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            Continuous Auto-Save
          </Badge>
        </div>

        {/* Candidate Check-In Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-2 border-t border-slate-800/80">
          {error && (
            <Alert variant="error" title="Unable to Start Assessment">
              {error}
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Full Name *"
              name="candidateName"
              placeholder="e.g. Jordan Taylor"
              autoComplete="name"
              required
              value={candidateName}
              onChange={(e) => setCandidateName(e.target.value)}
              onBlur={() => setTouched((prev) => ({ ...prev, name: true }))}
              error={nameError}
              disabled={loading}
            />

            <Input
              label="Email Address (optional)"
              name="candidateEmail"
              type="email"
              placeholder="jordan@example.com"
              autoComplete="email"
              value={candidateEmail}
              onChange={(e) => setCandidateEmail(e.target.value)}
              onBlur={() => setTouched((prev) => ({ ...prev, email: true }))}
              error={emailError}
              disabled={loading}
            />
          </div>

          {template.requires_access_code && (
            <div className="relative">
              <Input
                label="Access Code *"
                name="accessCode"
                type={showCode ? 'text' : 'password'}
                placeholder="Enter the access code provided by your interviewer"
                autoComplete="off"
                required
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, code: true }))}
                error={codeError}
                disabled={loading}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowCode((prev) => !prev)}
                aria-label={showCode ? 'Hide access code' : 'Show access code'}
                className="absolute right-2.5 top-[29px] rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 focus-ring"
              >
                {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-400">
              Your timer begins immediately after clicking <span className="text-slate-200 font-medium">Start Assessment</span>.
            </p>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              rightIcon={<ArrowRight className="h-4 w-4" />}
              className="w-full sm:w-auto shrink-0"
            >
              {loading ? 'Starting Session…' : 'Start Assessment'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
