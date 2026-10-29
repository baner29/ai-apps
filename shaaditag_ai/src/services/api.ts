import type {
  HashtagPackage,
  SplitWordHighlight,
} from '../types/hashtag';

export interface GenerateInputs {
  brideName: string;
  groomName: string;
  brideNickname?: string;
  groomNickname?: string;
  exclude?: string[];
}

// Generation is a background job on the server: starting returns a job id,
// and the result is polled for. Leaving the page mid-generation no longer
// loses the result — the app reattaches to the job when it comes back.
export async function startGenerateJob(inputs: GenerateInputs): Promise<string> {
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brideName: inputs.brideName,
      groomName: inputs.groomName,
      exclude: inputs.exclude || [],
      ...(inputs.brideNickname ? { brideNickname: inputs.brideNickname } : {}),
      ...(inputs.groomNickname ? { groomNickname: inputs.groomNickname } : {}),
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.jobId) {
    throw new Error(data.error || `Could not start generation (HTTP ${resp.status})`);
  }
  return data.jobId as string;
}

export type JobResult =
  | { status: 'running' }
  | { status: 'error'; error: string }
  | {
      status: 'done';
      packages: HashtagPackage[];
      highlight: SplitWordHighlight | null;
      modelUsed: string;
    };

export async function fetchJob(jobId: string): Promise<JobResult> {
  const resp = await fetch(`/api/generate/${jobId}`);
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 404) {
    return {
      status: 'error',
      error: data.error || 'That generation has expired. Please run it again.',
    };
  }
  if (data.status === 'done') {
    return {
      status: 'done',
      packages: Array.isArray(data.packages) ? data.packages : [],
      highlight: data.highlight || null,
      modelUsed: data.modelUsed || '',
    };
  }
  if (data.status === 'error') {
    return { status: 'error', error: data.error || 'Generation failed. Please try again.' };
  }
  return { status: 'running' };
}

export interface FeedbackPayload {
  sessionId: string;
  brideName: string;
  groomName: string;
  brideNickname: string;
  groomNickname: string;
  hashtag: string;
  rating: 'like' | 'dislike' | 'none';
  category: string;
  hinglishTranslation: string;
  meaningHook: string;
}

// Ratings are stored server-side in Firestore (hashtag_feedback) as the
// knowledge base for future tuning/training. Fire-and-forget from the UI.
export async function sendFeedback(payload: FeedbackPayload): Promise<boolean> {
  try {
    const resp = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
