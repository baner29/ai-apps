import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, Lock, Terminal } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { AdminStatus } from '../../types/api';
import { Alert, Badge, Button, Card, CardContent } from '../../components/ui';

export interface AdminLoginPageProps {
  status: AdminStatus;
  onAuthenticated: () => Promise<void> | void;
}

export function AdminLoginPage({ status, onAuthenticated }: AdminLoginPageProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const passwordInputId = useId();
  const errorId = useId();
  const headingId = useId();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password.trim()) {
      setError('Please enter the admin password to continue.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.admin.login(password);
      setPassword('');
      await onAuthenticated();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.detail : 'Authentication failed. Please verify your password.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-0 flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-5 animate-fade-in">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-surface-0 shadow-glow-indigo">
            <Terminal className="h-6 w-6 stroke-[2.5]" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-indigo-400">
              BigBank - Interview Platform
            </p>
            <h1 id={headingId} className="mt-0.5 text-xl font-bold tracking-tight text-slate-100">
              {status.app_title || 'BigBank'}
            </h1>
          </div>
        </div>

        <Card className="overflow-hidden border-slate-800/90">
          <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-cyan-400" />
          <CardContent className="space-y-5 p-6 sm:p-7">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                  <Lock className="h-4 w-4" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">Sign In Required</h2>
                  <p className="text-xs text-slate-400">Enter your administrator password</p>
                </div>
              </div>
              <Badge variant={status.read_only ? 'amber' : 'indigo'} dot>
                {status.read_only ? 'Read-Only' : 'Local Studio'}
              </Badge>
            </div>

            {status.read_only && (
              <Alert variant="warning" title="Candidate Deployment (Read-Only)">
                Catalog edits, settings writes, and grading overrides are disabled in candidate
                mode. You can inspect questions, templates, and results after signing in.
              </Alert>
            )}

            {error && (
              <Alert variant="error" id={errorId}>
                {error}
              </Alert>
            )}

            <form
              onSubmit={handleSubmit}
              aria-labelledby={headingId}
              className="space-y-4"
              noValidate
            >
              <div className="space-y-1.5">
                <label
                  htmlFor={passwordInputId}
                  className="block text-xs font-medium text-slate-300"
                >
                  Admin Password <span aria-hidden="true" className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <input
                    id={passwordInputId}
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    autoFocus
                    required
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error ? errorId : undefined}
                    placeholder="Enter admin password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    disabled={submitting}
                    className="w-full rounded-lg bg-surface-0/90 border border-slate-700/80 pl-3 pr-10 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 transition-colors hover:border-slate-600/90 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    aria-pressed={showPassword}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-200 transition-colors focus-ring rounded-r-lg"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                loading={submitting}
              >
                Sign In to BigBank
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors focus-ring rounded px-2 py-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Return to Candidate Portal
          </Link>
        </div>
      </div>
    </div>
  );
}
