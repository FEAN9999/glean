import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtDate, fmtDuration, fmtNum } from '../lib/format';
import { Empty, ExternalLink, Pager, Spinner, Status, useUi } from '../components/ui';

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

function KindTabs({ kind }: { kind: Kind }) {
  const { t } = useI18n();
  return (
    <nav className="tabs" aria-label={t('Loại dữ liệu', 'Data type')}>
      <Link className={kind === 'posts' ? 'on' : ''} aria-current={kind === 'posts' ? 'page' : undefined} to="/nhat-ky/bai-viet">
        {t('Bài viết', 'Threads')}
      </Link>
      <Link className={kind === 'comments' ? 'on' : ''} aria-current={kind === 'comments' ? 'page' : undefined} to="/nhat-ky/binh-luan">
        {t('Bình luận', 'Comments')}
      </Link>
    </nav>
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
  const base = `/nhat-ky/${kind === 'posts' ? 'bai-viet' : 'binh-luan'}`;

  return (
    <div className="page">
      <header className="page-head tight" style={{ alignItems: 'center' }}>
        <h1 className="page-title">{t('Nhật ký đồng bộ', 'Sync log')}</h1>
        <p className="page-lede" style={{ flex: 1, minWidth: 200 }}>
          {data
            ? t(`${fmtNum(data.total)} lần · mỗi dòng là một lần quét một chuyên mục`, `${fmtNum(data.total)} runs · each line is one pass over one section`)
            : t('Mỗi dòng là một lần quét một chuyên mục', 'Each line is one pass over one section')}
        </p>
        <button className="btn" onClick={() => void runNow()}>
          {t('Đồng bộ ngay', 'Sync now')}
        </button>
      </header>
      <KindTabs kind={kind} />
      {!data ? (
        <Spinner label={t('Đang tải', 'Loading')} />
      ) : !data.items.length ? (
        <Empty title={t('Chưa có lần đồng bộ nào', 'No sync runs yet')}>{t('Bật đồng bộ tự động trong Cài đặt hoặc chạy Đồng bộ thủ công.', 'Turn on auto-sync in Settings or run Manual sync.')}</Empty>
      ) : (
        <>
          <div className="gtable-scroll">
            <div className="gtable log-table">
              <div className="gtr log-row head" aria-hidden="true">
                <span>{t('Chuyên mục', 'Section')}</span>
                <span>{t('Bắt đầu', 'Started')}</span>
                <span>{t('Thời lượng', 'Duration')}</span>
                <span>{t('Cách chạy', 'Trigger')}</span>
                <span className="r">{kind === 'posts' ? t('Bài mới / đổi', 'New / changed') : t('Bình luận mới', 'New comments')}</span>
              </div>
              {data.items.map((h) => (
                <Link key={h.id} to={`${base}/${h.id}`} className="gtr log-row">
                  <span style={{ minWidth: 0 }}>
                    <span className="gt-title">{h.forumName}</span>
                    {h.error && (
                      <span className="error-text" style={{ display: 'block', margin: '2px 0 0' }}>
                        {h.error}
                      </span>
                    )}
                  </span>
                  <span className="muted">{fmtDate(h.syncStartedAt)}</span>
                  <span className="muted">
                    {h.syncFinishedAt ? fmtDuration((Date.parse(h.syncFinishedAt) - Date.parse(h.syncStartedAt)) / 1000) : t('đang chạy', 'running')}
                  </span>
                  <span className="muted">{h.trigger === 'auto' ? t('Tự động', 'Auto') : t('Thủ công', 'Manual')}</span>
                  <span className="r num" style={{ fontWeight: 400 }}>
                    {fmtNum(h.syncCount)}
                  </span>
                </Link>
              ))}
            </div>
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
  /**
   * edited / deleted: comments of the thread changed or removed on the forum (commentDelta = how many).
   * check-skipped: the pages read looked unreliable, so deleted comments were not looked for this time.
   */
  action: 'new' | 'updated' | 'comments' | 'edited' | 'deleted' | 'check-skipped';
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
      <nav className="crumbs" aria-label={t('Vị trí', 'Breadcrumb')}>
        <Link to={`/nhat-ky/${kind === 'posts' ? 'bai-viet' : 'binh-luan'}`}>{t('Nhật ký đồng bộ', 'Sync log')}</Link> › {kind === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')}
      </nav>
      <header className="page-head tight" style={{ paddingTop: 4 }}>
        <h1 className="page-title">{h.forumName}</h1>
        <p className="page-lede">
          {fmtDate(h.syncStartedAt)} · {h.trigger === 'auto' ? t('tự động', 'automatic') : t('thủ công', 'manual')} ·{' '}
          {kind === 'posts'
            ? t(`${fmtNum(h.syncCount)} bài mới hoặc được cập nhật`, `${fmtNum(h.syncCount)} new or updated threads`)
            : t(`${fmtNum(h.syncCount)} bình luận mới`, `${fmtNum(h.syncCount)} new comments`)}
        </p>
      </header>
      {h.error && (
        <div className="notice notice-rust" style={{ marginBottom: 16 }}>
          {h.error}
        </div>
      )}
      {!data.items.length ? (
        <Empty title={t('Lần này không có gì thay đổi', 'Nothing changed in this run')} />
      ) : (
        <ul className="rows" style={{ borderTop: '1px solid var(--line)' }}>
          {data.items.map((it) => (
            <li key={it.id} className="result" style={{ padding: '12px 0' }}>
              <div className="result-text">
                {it.url ? (
                  <ExternalLink href={it.url} className="result-title" style={{ fontSize: 14 }}>
                    {it.title}
                  </ExternalLink>
                ) : (
                  <span className="result-title" style={{ fontSize: 14 }}>
                    {it.title}
                  </span>
                )}
                <span className="row-meta">
                  <span>{it.author}</span>
                  {it.action === 'updated' && it.commentDelta !== 0 && <span>{t(`${it.commentDelta > 0 ? '+' : ''}${it.commentDelta} trả lời`, `${it.commentDelta > 0 ? '+' : ''}${it.commentDelta} replies`)}</span>}
                </span>
              </div>
              {!!it.isDeleted && <Status tone="bad">{t('Đã bị xóa trên diễn đàn', 'Deleted on the forum')}</Status>}
              <span className={`tag ${{ new: 'tag-moss', comments: 'tag-straw', deleted: 'tag-rust', updated: '', edited: '', 'check-skipped': '' }[it.action] ?? ''}`}>
                {it.action === 'new'
                  ? t('Bài mới', 'New')
                  : it.action === 'updated'
                    ? t('Cập nhật', 'Updated')
                    : it.action === 'edited'
                      ? t(`~${fmtNum(it.commentDelta)} sửa`, `~${fmtNum(it.commentDelta)} edited`)
                      : it.action === 'deleted'
                        ? t(`−${fmtNum(it.commentDelta)} đã xóa`, `−${fmtNum(it.commentDelta)} deleted`)
                        : it.action === 'check-skipped'
                          ? t('Bỏ qua kiểm tra xóa', 'Deletion check skipped')
                          : t(`+${fmtNum(it.commentDelta)} bình luận`, `+${fmtNum(it.commentDelta)} comments`)}
              </span>
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
