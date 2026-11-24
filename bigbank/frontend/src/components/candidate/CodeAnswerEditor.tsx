import { useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { Code2, RotateCcw } from 'lucide-react';
import { Badge, Button, Spinner } from '../ui';

export interface CodeAnswerEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: string | null;
  starterCode?: string | null;
  disabled?: boolean;
}

const LANGUAGE_ALIASES: Record<string, { monaco: string; label: string }> = {
  python: { monaco: 'python', label: 'Python' },
  py: { monaco: 'python', label: 'Python' },
  pyspark: { monaco: 'python', label: 'PySpark (Python)' },
  sql: { monaco: 'sql', label: 'SQL' },
  postgresql: { monaco: 'pgsql', label: 'PostgreSQL' },
  pgsql: { monaco: 'pgsql', label: 'PostgreSQL' },
  mysql: { monaco: 'mysql', label: 'MySQL' },
  javascript: { monaco: 'javascript', label: 'JavaScript' },
  js: { monaco: 'javascript', label: 'JavaScript' },
  typescript: { monaco: 'typescript', label: 'TypeScript' },
  ts: { monaco: 'typescript', label: 'TypeScript' },
  java: { monaco: 'java', label: 'Java' },
  go: { monaco: 'go', label: 'Go' },
  golang: { monaco: 'go', label: 'Go' },
  rust: { monaco: 'rust', label: 'Rust' },
  cpp: { monaco: 'cpp', label: 'C++' },
  'c++': { monaco: 'cpp', label: 'C++' },
  c: { monaco: 'c', label: 'C' },
  csharp: { monaco: 'csharp', label: 'C#' },
  'c#': { monaco: 'csharp', label: 'C#' },
  scala: { monaco: 'scala', label: 'Scala' },
  bash: { monaco: 'shell', label: 'Bash / Shell' },
  sh: { monaco: 'shell', label: 'Shell' },
  shell: { monaco: 'shell', label: 'Shell' },
  yaml: { monaco: 'yaml', label: 'YAML' },
  yml: { monaco: 'yaml', label: 'YAML' },
  json: { monaco: 'json', label: 'JSON' },
  hcl: { monaco: 'hcl', label: 'Terraform (HCL)' },
  terraform: { monaco: 'hcl', label: 'Terraform (HCL)' },
  dockerfile: { monaco: 'dockerfile', label: 'Dockerfile' },
};

function resolveLanguage(raw: string | null): { monaco: string; label: string } {
  const key = (raw ?? '').trim().toLowerCase();
  if (!key) {
    return { monaco: 'plaintext', label: 'Plain Text' };
  }
  return LANGUAGE_ALIASES[key] ?? { monaco: key, label: raw!.trim() };
}

export function CodeAnswerEditor({
  value,
  onChange,
  language,
  starterCode,
  disabled = false,
}: CodeAnswerEditorProps) {
  const langInfo = useMemo(() => resolveLanguage(language), [language]);
  const lineCount = useMemo(() => (value ? value.split('\n').length : 1), [value]);
  const canReset = Boolean(starterCode && value !== starterCode && !disabled);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800/90 bg-[#1e1e1e] shadow-sm">
      {/* Code Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-surface-1/95 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          <Badge variant="cyan" size="sm">
            {langInfo.label}
          </Badge>
          <span className="font-mono text-[11px] text-slate-400">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>

        {canReset && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => onChange(starterCode ?? '')}
            className="h-7 px-2.5 text-xs text-slate-300 hover:text-white"
          >
            Reset Starter Code
          </Button>
        )}
      </div>

      {/* Monaco Editor */}
      <div className="h-[400px] w-full">
        <Editor
          height="100%"
          language={langInfo.monaco}
          theme="vs-dark"
          value={value}
          onChange={(next) => onChange(next ?? '')}
          loading={
            <div className="flex h-full items-center justify-center gap-2 bg-surface-0 text-xs text-slate-400">
              <Spinner size="sm" label="Loading code editor" />
              Loading code editor…
            </div>
          }
          options={{
            readOnly: disabled,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            fontFamily:
              "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            tabSize: 4,
            insertSpaces: true,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderLineHighlight: 'line',
            padding: { top: 14, bottom: 14 },
            smoothScrolling: true,
            cursorBlinking: 'smooth',
          }}
        />
      </div>
    </div>
  );
}
