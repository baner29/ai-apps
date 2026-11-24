import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider, Button, Card, CardContent, Spinner } from './components/ui';
import { CandidateFlow } from './pages/candidate/CandidateFlow';

// Lazy-load Admin Studio routes so the Candidate Portal bundle stays minimal
const AdminLayout = lazy(() =>
  import('./pages/admin/AdminLayout').then((m) => ({ default: m.AdminLayout }))
);
const QuestionsPage = lazy(() =>
  import('./pages/admin/QuestionsPage').then((m) => ({ default: m.QuestionsPage }))
);
const TemplatesPage = lazy(() =>
  import('./pages/admin/TemplatesPage').then((m) => ({ default: m.TemplatesPage }))
);
const TemplateComposerPage = lazy(() =>
  import('./pages/admin/TemplateComposerPage').then((m) => ({ default: m.TemplateComposerPage }))
);
const ResultsPage = lazy(() =>
  import('./pages/admin/ResultsPage').then((m) => ({ default: m.ResultsPage }))
);
const SettingsPage = lazy(() =>
  import('./pages/admin/SettingsPage').then((m) => ({ default: m.SettingsPage }))
);
const DeployPage = lazy(() =>
  import('./pages/admin/DeployPage').then((m) => ({ default: m.DeployPage }))
);

function RouteLoadingFallback() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3">
      <Spinner size="lg" label="Loading workspace" />
      <p className="text-sm text-slate-400">Loading workspace…</p>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="min-h-screen bg-surface-0 flex items-center justify-center px-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="space-y-4 py-10">
          <p className="font-mono text-xs uppercase tracking-widest text-indigo-400">Error 404</p>
          <h1 className="text-xl font-semibold text-slate-100">Page Not Found</h1>
          <p className="text-xs text-slate-400">
            The requested route does not exist on BigBank - Interview Platform.
          </p>
          <div className="flex items-center justify-center gap-2 pt-2">
            <Link to="/">
              <Button variant="primary" size="sm">
                Candidate Portal
              </Button>
            </Link>
            <Link to="/admin">
              <Button variant="secondary" size="sm">
                Admin Studio
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            {/* Candidate Portal */}
            <Route path="/" element={<CandidateFlow />} />
            <Route path="/i/:slug" element={<CandidateFlow />} />

            {/* Admin Studio */}
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="questions" replace />} />
              <Route path="questions" element={<QuestionsPage />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="templates/new" element={<TemplateComposerPage />} />
              <Route path="templates/:id" element={<TemplateComposerPage />} />
              <Route path="results" element={<ResultsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="deploy" element={<DeployPage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

export default App;
