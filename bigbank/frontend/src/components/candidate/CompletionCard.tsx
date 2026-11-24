import { CheckCircle2, Clock, FileCheck2, Hash, RotateCcw } from 'lucide-react';
import { Badge, Button, Card, CardContent } from '../ui';

export interface CompletionCardProps {
  candidateName: string;
  templateName: string;
  roleTitle: string;
  submissionId: string;
  submittedAt: string;
  message?: string;
  answeredCount: number;
  totalQuestions: number;
  durationSeconds: number;
  previewMode?: boolean;
  onRestartPreview?: () => void;
  onExitPreview?: () => void;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export function CompletionCard({
  candidateName,
  templateName,
  roleTitle,
  submissionId,
  submittedAt,
  message,
  answeredCount,
  totalQuestions,
  durationSeconds,
  previewMode = false,
  onRestartPreview,
  onExitPreview,
}: CompletionCardProps) {
  return (
    <Card className="w-full max-w-xl overflow-hidden animate-slide-up">
      <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-cyan-400 to-indigo-500" />
      <CardContent className="space-y-6 p-6 sm:p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shadow-lg shadow-emerald-950/50">
          <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge variant="emerald" size="md">
              {previewMode ? 'Preview Complete' : 'Assessment Submitted'}
            </Badge>
            <Badge variant="indigo" size="md">
              {roleTitle}
            </Badge>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Thank you, {candidateName}!
          </h1>
          <p className="text-sm leading-relaxed text-slate-400">
            {message ||
              'Your responses have been securely recorded and delivered to the hiring team for review.'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 text-left sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <FileCheck2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              Answered
            </div>
            <p className="mt-1 text-base font-semibold text-slate-100">
              {answeredCount} / {totalQuestions}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <Clock className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
              Time Taken
            </div>
            <p className="mt-1 text-base font-semibold text-slate-100">
              {formatDuration(durationSeconds)}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <Hash className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              Submitted
            </div>
            <p className="mt-1 text-xs font-medium text-slate-200 leading-5">
              {formatTimestamp(submittedAt)}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-surface-0/60 px-4 py-3 text-left text-xs text-slate-400 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500">Assessment</span>
            <span className="font-medium text-slate-200 truncate">{templateName}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500">Reference ID</span>
            <code className="font-mono text-[11px] text-cyan-300 truncate">{submissionId}</code>
          </div>
        </div>

        {previewMode ? (
          <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2">
            {onRestartPreview && (
              <Button
                variant="secondary"
                size="md"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={onRestartPreview}
              >
                Restart Preview
              </Button>
            )}
            {onExitPreview && (
              <Button variant="primary" size="md" onClick={onExitPreview}>
                Return to Admin Studio
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-500 pt-1">
            You may safely close this browser window now.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
