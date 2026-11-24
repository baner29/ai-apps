import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext } from 'react-router-dom';
import {
  ClipboardCheck,
  Database,
  ExternalLink,
  Layers,
  Lock,
  LogOut,
  RefreshCw,
  Rocket,
  Settings,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { AdminStatus } from '../../types/api';
import { Alert, Badge, Button, Card, CardContent, Spinner } from '../../components/ui';
import { AdminLoginPage } from './AdminLoginPage';

export interface AdminOutletContext {
  status: AdminStatus;
  readOnly: boolean;
  refreshStatus: () => Promise<void>;
}

export function useAdminContext(): AdminOutletContext {
  return useOutletContext<AdminOutletContext>();
}

const NAV_ITEMS = [
  { to: '/admin/questions', label: 'Questions', icon: Database },
  { to: '/admin/templates', label: 'Templates', icon: Layers },
  { to: '/admin/results', label: 'Results', icon: ClipboardCheck },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
  { to: '/admin/deploy', label: 'Package & Deploy', icon: Rocket },
] as const;

export function AdminLayout() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    setLoadError(null);
    try {
      const data = await api.admin.getStatus();
      setStatus(data);
      document.title =
        data.app_title && data.app_title !== 'BigBank'
          ? `${data.app_title} · BigBank - An open source interview taking platform`
          : 'BigBank - An open source interview taking platform';
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setLoadError(
          err instanceof ApiError
            ? err.detail
            : 'Unable to reach Admin API. Ensure the backend server is running.'
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleLogout = async () => {
    api.admin.logout();
    await fetchStatus();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0 flex flex-col items-center justify-center gap-3">
        <Spinner size="lg" label="Loading BigBank" />
        <p className="text-sm text-slate-400">Connecting to BigBank - Interview Platform…</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-surface-0 flex items-center justify-center px-4">
        <Card className="w-full max-w-md border-slate-800/90 animate-fade-in">
          <CardContent className="space-y-4 py-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800/80 text-slate-400 border border-slate-700/70">
              <ShieldAlert className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
                Not Available
              </p>
              <h1 className="text-lg font-semibold text-slate-100">Admin Portal Disabled</h1>
              <p className="text-xs leading-relaxed text-slate-400">
                This deployment is running in candidate-only mode without an admin password
                configured.
              </p>
            </div>
            <div className="pt-1">
              <Link to="/" className="inline-block">
                <Button variant="primary" size="sm">
                  Return to Candidate Portal
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadError || !status) {
    return (
      <div className="min-h-screen bg-surface-0 flex items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-4 py-6">
            <Alert variant="error" title="Admin Connection Error">
              {loadError ?? 'Unexpected error loading admin status.'}
            </Alert>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => void fetchStatus()}
              >
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status.auth_required && !status.authenticated) {
    return <AdminLoginPage status={status} onAuthenticated={fetchStatus} />;
  }

  return (
    <div className="min-h-screen bg-surface-0 text-slate-100 flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-surface-1/90 flex flex-col">
        <div className="flex h-16 items-center justify-between gap-3 px-5 border-b border-slate-800/80">
          <Link
            to="/admin/questions"
            className="flex items-center gap-3 min-w-0 focus-ring rounded-lg"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-surface-0 shadow-glow-indigo shrink-0">
              <Terminal className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight text-slate-100">
                {status.app_title || 'BigBank'}
              </p>
              <p className="truncate text-[11px] font-medium text-slate-400">
                BigBank - Interview Platform
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-2 lg:hidden">
            <Badge variant={status.read_only ? 'amber' : 'emerald'} dot>
              {status.read_only ? 'Read-Only' : 'Local'}
            </Badge>
            {status.auth_required && (
              <button
                type="button"
                onClick={() => void handleLogout()}
                aria-label="Sign out"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-300 focus-ring"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <nav
          aria-label="Admin Studio navigation"
          className="flex lg:flex-col gap-1 overflow-x-auto px-3 py-3 lg:py-4 flex-1"
        >
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-ring',
                  isActive
                    ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 shadow-sm shadow-indigo-950/30'
                    : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100 border border-transparent'
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="hidden lg:flex flex-col gap-2.5 p-4 border-t border-slate-800/80 bg-surface-0/40">
          <div className="flex items-center justify-between gap-2">
            <Badge variant={status.read_only ? 'amber' : 'emerald'} dot>
              {status.read_only ? 'Candidate · Read-Only' : 'Local Studio'}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-cyan-300 transition-colors focus-ring rounded px-1 py-0.5"
            >
              Candidate Portal
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
            {status.auth_required && (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-rose-300 transition-colors focus-ring rounded px-1.5 py-0.5"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                Sign out
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        {status.read_only && (
          <div
            role="status"
            className="border-b border-amber-500/25 bg-amber-500/10 px-5 sm:px-8 py-2.5 text-xs text-amber-200 flex items-center gap-2"
          >
            <Lock className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
            <span>
              <strong>Read-Only Mode:</strong> Candidate deployments disable question, template,
              settings, and grading mutations.
            </span>
          </div>
        )}

        <main className="flex-1 px-5 py-6 sm:px-8 sm:py-7 max-w-7xl w-full mx-auto">
          <Outlet
            context={
              {
                status,
                readOnly: status.read_only,
                refreshStatus: fetchStatus,
              } satisfies AdminOutletContext
            }
          />
        </main>
      </div>
    </div>
  );
}
