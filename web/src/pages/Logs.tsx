import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtDate, fmtDuration, fmtNum } from '../lib/format';
import { Empty, ExternalLink, Pager, Spinner, useUi } from '../components/ui';

type Kind = 'posts' | 'comments';

interface History {
  id: number;
  type: Kind;
  trigger: 'auto' | 'manual';
  forum: number;
  forumName: string;
  syncCount: number;
  syncStartedAt: string;
  syncFinishedAt: string | null;
  error: string | null;
}

function KindSwitch({ kind }: { kind: Kind }) {
  const { t } = useI18n();
  return (
    <div className="seg" style={{ marginBottom: 20 }}>
      <Link className={kind === 'posts' ? 'on' : ''} to="/nhat-ky/bai-viet">
        {t('Bài viết', 'Threads')}
      </Link>
      <Link className={kind === 'comments' ? 'on' : ''} to="/nhat-ky/binh-luan">
        {t('Bình luận', 'Comments')}
      </Link>
    </div>
  );
}

export function SyncLogPage({ kind }: { kind: Kind }) {
  const { t } = useI18n();
  const { toast } = useUi();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: History[]; total: number } | null>(null);
  const size = 20;
  const load = useCallback(
    (p: number) =>
      api
        .get<History[]>(`/sync-histories/${kind}?page=${p}&size=${size}`, { quiet: true })
        .then((r) => setData({ items: r.data, total: r.total ?? 0 }))
        .catch(() => setData({ items: [], total: 0 })),
    [kind],
  );
  useEffect(() => {
    setPage(1);
    setData(null);
    void load(1);
  }, [load]);
  useEvent([Ev.AutoSyncFinished, Ev.ManualSyncComplete, Ev.ManualSyncFailed], () => void load(page));

  const runNow = async () => {
    await api.post(`/sync/auto/${kind}/run-now`);
    toast(t('Đã bắt đầu một lượt đồng bộ. Nhật ký sẽ tự cập nhật khi xong.', 'A sync run started. The log updates when it finishes.'));
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Nhật ký đồng bộ', 'Sync log')}</h1>
        <p className="page-lede">
          {t(
            'Mỗi dòng là một lần Glean quét một chuyên mục và nạp bài viết hoặc bình luận mới vào kho. Mở một dòng để xem đúng những bài đã thay đổi.',
            'Each line is one pass over a forum section that loaded new threads or comments into the archive. Open a line to see exactly what changed.',
          )}
        </p>
      </header>
      <div className="hstack" style={{ justifyContent: 'space-between' }}>
        <KindSwitch kind={kind} />
        <button className="btn btn-sm" onClick={() => void runNow()} style={{ marginBottom: 20 }}>
          {t('Đồng bộ ngay', 'Sync now')}
        </button>
      </div>
      {!data ? (
        <Spinner label={t('Đang tải', 'Loading')} />
      ) : !data.items.length ? (
        <Empty title={t('Chưa có lần đồng bộ nào', 'No sync runs yet')}>{t('Bật đồng bộ tự động trong Cài đặt hoặc chạy Đồng bộ thủ công.', 'Turn on auto-sync in Settings or run Manual sync.')}</Empty>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 14 }}>{t(`${fmtNum(data.total)} lần đồng bộ`, `${fmtNum(data.total)} runs`)}</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Chuyên mục', 'Section')}</th>
                  <th>{t('Bắt đầu', 'Started')}</th>
                  <th>{t('Thời lượng', 'Duration')}</th>
                  <th>{t('Cách chạy', 'Trigger')}</th>
                  <th className="r">{kind === 'posts' ? t('Bài mới / đổi', 'New / changed') : t('Bình luận mới', 'New comments')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <Link to={`/nhat-ky/${kind === 'posts' ? 'bai-viet' : 'binh-luan'}/${h.id}`} style={{ fontWeight: 500 }}>
                        {h.forumName}
                      </Link>
                      {h.error && (
                        <div className="error-text" style={{ margin: '2px 0 0', fontSize: 13 }}>
                          {h.error}
                        </div>
                      )}
                    </td>
                    <td className="muted">{fmtDate(h.syncStartedAt)}</td>
                    <td className="muted">
                      {h.syncFinishedAt ? fmtDuration((Date.parse(h.syncFinishedAt) - Date.parse(h.syncStartedAt)) / 1000) : t('đang chạy', 'running')}
                    </td>
                    <td className="muted">{h.trigger === 'auto' ? t('Tự động', 'Auto') : t('Thủ công', 'Manual')}</td>
                    <td className="r num">{fmtNum(h.syncCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={page}
            total={data.total}
            size={size}
            onPage={(p) => {
              setPage(p);
              void load(p);
            }}
          />
        </>
      )}
    </div>
  );
}

interface Item {
  id: number;
  threadId: number;
  title: string;
  author: string;
  action: 'new' | 'updated' | 'comments';
  commentDelta: number;
  url: string | null;
  isDeleted: number | null;
}

export function SyncLogDetailPage({ kind }: { kind: Kind }) {
  const { id } = useParams();
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ history: History; items: Item[]; total: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const size = 50;
  const load = useCallback(
    (p: number) =>
      api
        .get<{ history: History; items: Item[] }>(`/sync-histories/${kind}/${id}/items?page=${p}&size=${size}`, { quiet: true })
        .then((r) => setData({ ...r.data, total: r.total ?? 0 }))
        .catch(() => setMissing(true)),
    [id, kind],
  );
  useEffect(() => void load(1), [load]);

  if (missing) return <div className="page"><Empty title={t('Không tìm thấy lần đồng bộ này', 'Sync run not found')} /></div>;
  if (!data) return <div className="page"><Spinner label={t('Đang tải', 'Loading')} /></div>;
  const h = data.history;
  return (
    <div className="page">
      <Link to={`/nhat-ky/${kind === 'posts' ? 'bai-viet' : 'binh-luan'}`} className="link-btn muted" style={{ fontSize: 14 }}>
        {t('Nhật ký đồng bộ', 'Sync log')}
      </Link>
      <header className="page-head" style={{ marginTop: 12 }}>
        <h1 className="page-title" style={{ fontSize: 34 }}>
          {h.forumName}
        </h1>
        <p className="page-lede">
          {fmtDate(h.syncStartedAt)}, {h.trigger === 'auto' ? t('tự động', 'automatic') : t('thủ công', 'manual')}.{' '}
          {kind === 'posts'
            ? t(`${fmtNum(h.syncCount)} bài mới hoặc được cập nhật.`, `${fmtNum(h.syncCount)} new or updated threads.`)
            : t(`${fmtNum(h.syncCount)} bình luận mới.`, `${fmtNum(h.syncCount)} new comments.`)}
        </p>
      </header>
      {!data.items.length ? (
        <Empty title={t('Lần này không có gì thay đổi', 'Nothing changed in this run')} />
      ) : (
        <ul className="rows">
          {data.items.map((it) => (
            <li key={it.id} className="row" style={{ gap: 4 }}>
              <div className="hstack" style={{ justifyContent: 'space-between' }}>
                {it.url ? (
                  <ExternalLink href={it.url} className="row-title" style={{ fontSize: 15.5 }}>
                    {it.title}
                  </ExternalLink>
                ) : (
                  <span className="row-title">{it.title}</span>
                )}
                <span className={`tag ${it.action === 'new' ? 'tag-moss' : it.action === 'comments' ? 'tag-straw' : ''}`}>
                  {it.action === 'new'
                    ? t('Bài mới', 'New')
                    : it.action === 'updated'
                      ? t('Cập nhật', 'Updated')
                      : t(`+${fmtNum(it.commentDelta)} bình luận`, `+${fmtNum(it.commentDelta)} comments`)}
                </span>
              </div>
              <div className="row-meta">
                <span>{it.author}</span>
                {it.action === 'updated' && it.commentDelta !== 0 && <span>{t(`${it.commentDelta > 0 ? '+' : ''}${it.commentDelta} trả lời`, `${it.commentDelta > 0 ? '+' : ''}${it.commentDelta} replies`)}</span>}
                {!!it.isDeleted && <span className="tag tag-rust">{t('Đã bị xóa trên diễn đàn', 'Deleted on the forum')}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pager
        page={page}
        total={data.total}
        size={size}
        onPage={(p) => {
          setPage(p);
          void load(p);
        }}
      />
    </div>
  );
}
