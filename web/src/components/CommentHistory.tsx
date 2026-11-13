import { useState } from 'react';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDate } from '../lib/format';

interface Revision {
  id: number;
  content: string;
  capturedAt: string;
  replacedAt: string;
}

/**
 * Tags for a comment that changed on the forum: "edited · N" (opens the earlier versions) and
 * "deleted on the forum". Renders nothing for an unchanged comment.
 */
export function CommentChanges({
  id,
  editCount,
  editedAt,
  deletedAt,
}: {
  id: number;
  editCount?: number | null;
  editedAt?: string | null;
  deletedAt?: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [error, setError] = useState('');
  if (!editCount && !deletedAt) return null;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || revs) return;
    try {
      setRevs((await api.get<Revision[]>(`/comments/${id}/revisions`, { quiet: true })).data);
    } catch (e) {
      setError((e as ApiErr).message);
    }
  };

  return (
    <span className="changes">
      <span className="changes-tags">
        {!!editCount && (
          <button
            type="button"
            className="tag tag-straw changes-toggle"
            aria-expanded={open}
            title={editedAt ? t(`Diễn đàn ghi sửa lần cuối lúc ${fmtDate(editedAt)}`, `The forum shows a last edit at ${fmtDate(editedAt)}`) : undefined}
            onClick={() => void toggle()}
          >
            {t(`đã sửa · ${editCount} lần`, `edited · ${editCount}×`)}
            <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        )}
        {deletedAt && (
          <span className="tag tag-rust" title={t('Glean phát hiện bình luận này không còn trên diễn đàn', 'Glean found this comment gone from the forum')}>
            {t(`đã xóa trên diễn đàn · ${fmtDate(deletedAt)}`, `deleted on the forum · ${fmtDate(deletedAt)}`)}
          </span>
        )}
      </span>
      {open && (
        <span className="revisions" role="region" aria-label={t('Các bản trước', 'Earlier versions')}>
          {error ? (
            <span className="muted">{error}</span>
          ) : !revs ? (
            <span className="muted">{t('Đang tải các bản trước…', 'Loading earlier versions…')}</span>
          ) : (
            revs.map((r) => (
              <span key={r.id} className="revision">
                <span className="row-meta plain">{t(`Bản trước · bị thay lúc ${fmtDate(r.replacedAt)}`, `Earlier version · replaced ${fmtDate(r.replacedAt)}`)}</span>
                <span className="row-body">{r.content || <span className="muted">{t('(trống)', '(empty)')}</span>}</span>
              </span>
            ))
          )}
        </span>
      )}
    </span>
  );
}
