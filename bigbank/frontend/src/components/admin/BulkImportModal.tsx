import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CopyCheck,
  Download,
  FileCode,
  FileJson,
  FileUp,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { api, ApiError, triggerBlobDownload } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  DuplicateStrategy,
  ExportFormat,
  ImportCommitResponse,
  ImportItemStatus,
  ImportPreviewItem,
  ImportPreviewResponse,
} from '../../types/api';
import { Alert, Badge, Button, Modal, Spinner } from '../ui';

export interface BulkImportModalProps {
  open: boolean;
  readOnly?: boolean;
  onClose: () => void;
  onImported: (summary: ImportCommitResponse) => void;
}

type PreviewFilter = 'all' | ImportItemStatus;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMatchReason(reason: ImportPreviewItem['match_reason']): string {
  switch (reason) {
    case 'external_key':
      return 'Matches existing external_key';
    case 'prompt':
      return 'Matches existing prompt';
    case 'in_batch_external_key':
      return 'Duplicate external_key in file';
    case 'in_batch_prompt':
      return 'Duplicate prompt in file';
    default:
      return 'Duplicate';
  }
}

export function BulkImportModal({
  open,
  readOnly = false,
  onClose,
  onImported,
}: BulkImportModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [statusFilter, setStatusFilter] = useState<PreviewFilter>('all');

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [downloadingSample, setDownloadingSample] = useState<ExportFormat | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const captionId = useId();
  const strategyGroupName = useId();

  const resetState = () => {
    setSelectedFile(null);
    setIsDragging(false);
    setPreviewLoading(false);
    setPreview(null);
    setPreviewError(null);
    setDuplicateStrategy('skip');
    setSkipInvalid(false);
    setStatusFilter('all');
    setCommitting(false);
    setCommitError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open]);

  const validateFile = async (file: File) => {
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.json') && !lowerName.endsWith('.yaml') && !lowerName.endsWith('.yml')) {
      setSelectedFile(file);
      setPreview(null);
      setPreviewError('Unsupported file extension. Please upload a .json, .yaml, or .yml file.');
      return;
    }

    setSelectedFile(file);
    setPreview(null);
    setPreviewError(null);
    setCommitError(null);
    setSkipInvalid(false);
    setStatusFilter('all');
    setPreviewLoading(true);

    try {
      const result = await api.admin.previewImportFile(file);
      setPreview(result);
      if (result.invalid_count > 0 && result.valid_count === 0) {
        setStatusFilter('invalid');
      }
    } catch (err: unknown) {
      setPreviewError(
        err instanceof ApiError
          ? err.detail
          : 'Failed to parse and validate the uploaded file.'
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      void validateFile(file);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!readOnly && !isDragging) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (readOnly) return;
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void validateFile(file);
    }
  };

  const handleDownloadSample = async (format: ExportFormat) => {
    setDownloadingSample(format);
    try {
      const blob = await api.admin.downloadSampleQuestions(format);
      triggerBlobDownload(blob, `sample_questions.${format}`);
    } catch (err: unknown) {
      setPreviewError(
        err instanceof ApiError
          ? err.detail
          : `Unable to download sample ${format.toUpperCase()} template.`
      );
    } finally {
      setDownloadingSample(null);
    }
  };

  const handleCommit = async () => {
    if (!selectedFile || !preview || readOnly) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const summary = await api.admin.commitImportFile(selectedFile, {
        duplicate_strategy: duplicateStrategy,
        skip_invalid: skipInvalid,
      });
      onImported(summary);
      onClose();
    } catch (err: unknown) {
      setCommitError(
        err instanceof ApiError ? err.detail : 'Import commit failed. No partial changes saved.'
      );
    } finally {
      setCommitting(false);
    }
  };

  const filteredItems = useMemo(() => {
    if (!preview) return [];
    if (statusFilter === 'all') return preview.items;
    return preview.items.filter((item) => item.status === statusFilter);
  }, [preview, statusFilter]);

  const errorByIndex = useMemo(() => {
    const map = new Map<number, { title: string; external_key: string | null; error: string }>();
    if (!preview) return map;
    for (const err of preview.errors) {
      map.set(err.index, {
        title: err.title,
        external_key: err.external_key,
        error: err.error,
      });
    }
    return map;
  }, [preview]);

  const canCommit = Boolean(
    selectedFile &&
      preview &&
      !previewLoading &&
      !readOnly &&
      preview.valid_count > 0 &&
      (preview.invalid_count === 0 || skipInvalid)
  );

  const expectedWriteCount = useMemo(() => {
    if (!preview) return 0;
    return duplicateStrategy === 'overwrite'
      ? preview.new_count + preview.duplicate_count
      : preview.new_count;
  }, [preview, duplicateStrategy]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!committing}
      title="Bulk Import Questions (JSON / YAML)"
      description="Upload a canonical YAML/JSON question bank or legacy flat JSON array. Every item is validated before anything touches the database."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={committing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCommit()}
            disabled={!canCommit}
            loading={committing}
            leftIcon={<Upload className="h-4 w-4" />}
          >
            {preview
              ? expectedWriteCount > 0
                ? `Commit Import (${expectedWriteCount} ${expectedWriteCount === 1 ? 'question' : 'questions'})`
                : 'Commit Import (0 changes)'
              : 'Commit Import'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Sample Template Downloads */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/90 bg-surface-0/60 px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-200">Need a starter schema?</p>
            <p className="text-[11px] text-slate-400">
              Download a sample file containing MCQ, Text, Code, and Python Notebook examples.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={downloadingSample === 'yaml'}
              leftIcon={<FileCode className="h-3.5 w-3.5 text-cyan-400" />}
              rightIcon={<Download className="h-3 w-3 opacity-70" />}
              onClick={() => void handleDownloadSample('yaml')}
            >
              Sample YAML
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={downloadingSample === 'json'}
              leftIcon={<FileJson className="h-3.5 w-3.5 text-indigo-400" />}
              rightIcon={<Download className="h-3 w-3 opacity-70" />}
              onClick={() => void handleDownloadSample('json')}
            >
              Sample JSON
            </Button>
          </div>
        </div>

        {/* Drag & Drop Zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'relative rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all',
            isDragging
              ? 'border-indigo-400 bg-indigo-500/15 shadow-glow-indigo'
              : selectedFile
                ? 'border-slate-700/90 bg-surface-0/60'
                : 'border-slate-700/80 bg-surface-0/40 hover:border-indigo-500/60 hover:bg-surface-0/70'
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.yaml,.yml,application/json,application/x-yaml,text/yaml"
            onChange={handleFileInputChange}
            disabled={readOnly || previewLoading || committing}
            aria-label="Choose JSON or YAML question file"
            className="sr-only"
          />

          {!selectedFile ? (
            <div className="flex flex-col items-center gap-2.5">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                <FileUp className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-100">
                  Drag and drop your <span className="font-mono text-cyan-300">.yaml</span>,{' '}
                  <span className="font-mono text-cyan-300">.yml</span>, or{' '}
                  <span className="font-mono text-indigo-300">.json</span> file here
                </p>
                <p className="text-xs text-slate-400">
                  Supports canonical object schema and legacy flat JSON arrays
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-1"
                disabled={readOnly}
                onClick={() => fileInputRef.current?.click()}
              >
                Browse Local Files
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 text-left">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                  {selectedFile.name.toLowerCase().endsWith('.json') ? (
                    <FileJson className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <FileCode className="h-5 w-5" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-100">
                    {selectedFile.name}
                  </p>
                  <p className="font-mono text-[11px] text-slate-400">
                    {formatBytes(selectedFile.size)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={previewLoading || committing}
                  leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace File
                </Button>
                <button
                  type="button"
                  onClick={resetState}
                  disabled={previewLoading || committing}
                  aria-label="Clear selected file"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors focus-ring"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Loading Validation */}
        {previewLoading && (
          <div className="flex items-center justify-center gap-3 rounded-xl border border-slate-800 bg-surface-0/60 py-8">
            <Spinner size="md" label="Validating import file" />
            <span className="text-sm text-slate-300">
              Parsing and validating questions against the catalog…
            </span>
          </div>
        )}

        {/* Parse / API Error */}
        {previewError && (
          <Alert variant="error" title="File Validation Failed">
            {previewError}
          </Alert>
        )}

        {commitError && (
          <Alert variant="error" title="Import Failed">
            {commitError}
          </Alert>
        )}

        {/* Validation Preview Summary & Details */}
        {preview && !previewLoading && (
          <div className="space-y-4 animate-fade-in">
            {/* Summary Count Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-emerald-300">New Questions</span>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                </div>
                <p className="mt-1 font-mono text-2xl font-bold text-slate-100">
                  {preview.new_count}
                </p>
                <p className="text-[11px] text-emerald-200/75">Ready to insert into catalog</p>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-amber-300">Duplicates</span>
                  <CopyCheck className="h-4 w-4 text-amber-400" aria-hidden="true" />
                </div>
                <p className="mt-1 font-mono text-2xl font-bold text-slate-100">
                  {preview.duplicate_count}
                </p>
                <p className="text-[11px] text-amber-200/75">
                  {duplicateStrategy === 'overwrite'
                    ? 'Will update matching records'
                    : 'Will be skipped on commit'}
                </p>
              </div>

              <div
                className={cn(
                  'rounded-xl border px-4 py-3',
                  preview.invalid_count > 0
                    ? 'border-rose-500/40 bg-rose-500/10'
                    : 'border-slate-800 bg-surface-0/60'
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      'text-xs font-medium',
                      preview.invalid_count > 0 ? 'text-rose-300' : 'text-slate-400'
                    )}
                  >
                    Invalid Rows
                  </span>
                  <AlertCircle
                    className={cn(
                      'h-4 w-4',
                      preview.invalid_count > 0 ? 'text-rose-400' : 'text-slate-500'
                    )}
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-1 font-mono text-2xl font-bold text-slate-100">
                  {preview.invalid_count}
                </p>
                <p
                  className={cn(
                    'text-[11px]',
                    preview.invalid_count > 0 ? 'text-rose-200/80' : 'text-slate-500'
                  )}
                >
                  {preview.invalid_count > 0
                    ? 'Inspect exact errors below'
                    : 'All rows passed schema validation'}
                </p>
              </div>
            </div>

            {/* Duplicate Strategy & Invalid Row Handling */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <fieldset className="rounded-xl border border-slate-800 bg-surface-0/60 p-3.5 space-y-2">
                <legend className="text-xs font-semibold text-slate-200 px-1">
                  Duplicate Handling Strategy
                </legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors',
                      duplicateStrategy === 'skip'
                        ? 'border-indigo-500/60 bg-indigo-500/15'
                        : 'border-slate-800 bg-surface-1/60 hover:border-slate-700'
                    )}
                  >
                    <input
                      type="radio"
                      name={strategyGroupName}
                      value="skip"
                      checked={duplicateStrategy === 'skip'}
                      onChange={() => setDuplicateStrategy('skip')}
                      className="mt-0.5 h-3.5 w-3.5 text-indigo-500"
                    />
                    <div>
                      <span className="block text-xs font-semibold text-slate-100">Skip</span>
                      <span className="block text-[11px] text-slate-400">
                        Keep existing bank questions untouched
                      </span>
                    </div>
                  </label>

                  <label
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors',
                      duplicateStrategy === 'overwrite'
                        ? 'border-amber-500/60 bg-amber-500/15'
                        : 'border-slate-800 bg-surface-1/60 hover:border-slate-700'
                    )}
                  >
                    <input
                      type="radio"
                      name={strategyGroupName}
                      value="overwrite"
                      checked={duplicateStrategy === 'overwrite'}
                      onChange={() => setDuplicateStrategy('overwrite')}
                      className="mt-0.5 h-3.5 w-3.5 text-amber-500"
                    />
                    <div>
                      <span className="block text-xs font-semibold text-slate-100">Overwrite</span>
                      <span className="block text-[11px] text-slate-400">
                        Update matching questions in place
                      </span>
                    </div>
                  </label>
                </div>
              </fieldset>

              {preview.invalid_count > 0 ? (
                <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3.5 flex flex-col justify-between gap-2.5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle
                      className="h-4 w-4 text-rose-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <div className="text-xs text-rose-200">
                      <p className="font-semibold">
                        {preview.invalid_count}{' '}
                        {preview.invalid_count === 1 ? 'row failed' : 'rows failed'} validation
                      </p>
                      <p className="mt-0.5 text-[11px] text-rose-200/80">
                        {preview.valid_count > 0
                          ? 'Fix your file and re-upload, or opt in to skip invalid rows and import the valid ones.'
                          : 'No valid rows found. Please resolve the errors below and re-upload.'}
                      </p>
                    </div>
                  </div>

                  {preview.valid_count > 0 && (
                    <label className="inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-surface-0/70 px-3 py-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={skipInvalid}
                        onChange={(e) => setSkipInvalid(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500"
                      />
                      <span className="text-xs font-medium text-slate-100">
                        Skip {preview.invalid_count} invalid{' '}
                        {preview.invalid_count === 1 ? 'row' : 'rows'} and import{' '}
                        {preview.valid_count} valid
                      </span>
                    </label>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5 flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" aria-hidden="true" />
                  <div className="text-xs text-slate-300">
                    <p className="font-semibold text-emerald-200">Clean Validation Check</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      All {preview.items.length}{' '}
                      {preview.items.length === 1 ? 'item' : 'items'} parsed cleanly with zero
                      schema errors.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Filter Pills for Preview Table */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p id={captionId} className="text-xs font-semibold text-slate-200">
                Row-by-Row Validation Preview ({preview.items.length} total)
              </p>
              <div className="inline-flex flex-wrap rounded-lg border border-slate-800 bg-surface-0/90 p-0.5 text-xs">
                {(
                  [
                    { key: 'all', label: `All (${preview.items.length})` },
                    { key: 'new', label: `New (${preview.new_count})` },
                    { key: 'duplicate', label: `Duplicates (${preview.duplicate_count})` },
                    { key: 'invalid', label: `Invalid (${preview.invalid_count})` },
                  ] as Array<{ key: PreviewFilter; label: string }>
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setStatusFilter(tab.key)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors focus-ring',
                      statusFilter === tab.key
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Accessible Scrollable Preview Table */}
            <div
              tabIndex={0}
              role="region"
              aria-labelledby={captionId}
              className="max-h-[300px] overflow-auto rounded-xl border border-slate-800/90 bg-surface-0/70 custom-scrollbar focus-ring"
            >
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur-sm border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 w-14">
                      Row
                    </th>
                    <th scope="col" className="px-3 py-2.5 w-28">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      Question
                    </th>
                    <th scope="col" className="px-3 py-2.5 w-36">
                      Format / Diff
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      Details / Errors
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filteredItems.map((item) => {
                    const errMeta = errorByIndex.get(item.index);
                    const displayTitle =
                      item.question?.title || errMeta?.title || `Item #${item.index + 1}`;
                    const displayKey = item.question?.external_key || errMeta?.external_key;

                    return (
                      <tr
                        key={item.index}
                        className={cn(
                          'align-top transition-colors',
                          item.status === 'invalid'
                            ? 'bg-rose-500/5 hover:bg-rose-500/10'
                            : 'hover:bg-slate-800/40'
                        )}
                      >
                        <td className="px-3 py-2.5 font-mono text-slate-400">#{item.index + 1}</td>
                        <td className="px-3 py-2.5">
                          {item.status === 'new' && (
                            <Badge variant="emerald" dot>
                              New
                            </Badge>
                          )}
                          {item.status === 'duplicate' && (
                            <Badge variant="amber" dot>
                              Duplicate
                            </Badge>
                          )}
                          {item.status === 'invalid' && (
                            <Badge variant="rose" dot>
                              Invalid
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-slate-100 line-clamp-1">{displayTitle}</p>
                          {displayKey && (
                            <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                              {displayKey}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {item.question ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge variant="indigo" size="sm">
                                {item.question.format.toUpperCase()}
                              </Badge>
                              <Badge variant="slate" size="sm">
                                {item.question.difficulty}
                              </Badge>
                            </div>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {item.status === 'invalid' ? (
                            <ul className="space-y-1 text-rose-300">
                              {(item.errors.length > 0
                                ? item.errors
                                : [errMeta?.error ?? 'Validation error']
                              ).map((msg, errIdx) => (
                                <li key={errIdx} className="leading-snug">
                                  • {msg}
                                </li>
                              ))}
                            </ul>
                          ) : item.status === 'duplicate' ? (
                            <span className="text-amber-300/90">
                              {formatMatchReason(item.match_reason)}
                              {item.existing_id ? ` (ID #${item.existing_id})` : ''}
                            </span>
                          ) : (
                            <span className="text-slate-400">
                              {item.question?.default_points ?? 10} pts
                              {item.question && item.question.tags.length > 0
                                ? ` · ${item.question.tags.slice(0, 3).join(', ')}`
                                : ''}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {filteredItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                        No items match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
