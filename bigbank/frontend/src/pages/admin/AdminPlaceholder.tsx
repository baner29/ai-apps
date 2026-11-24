import { useParams } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { Badge, Card, CardContent, EmptyState } from '../../components/ui';
import { useAdminContext } from './AdminShell';

export interface AdminPlaceholderProps {
  title: string;
  description: string;
  sectionKey: string;
}

export function AdminPlaceholder({ title, description, sectionKey }: AdminPlaceholderProps) {
  const { id } = useParams<{ id?: string }>();
  const { status } = useAdminContext();

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            {title}
            {id ? ` #${id}` : ''}
          </h1>
          <p className="mt-1 text-sm text-slate-400">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="indigo">{sectionKey}</Badge>
          <Badge variant={status.read_only ? 'amber' : 'emerald'} dot>
            {status.read_only ? 'Read-Only' : 'Editable'}
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          <EmptyState
            icon={<Layers className="h-5 w-5" />}
            title={`${title} Workspace`}
            description="Route shell and typed API client are configured. Module implementation plugs directly into this view."
          />
        </CardContent>
      </Card>
    </div>
  );
}
