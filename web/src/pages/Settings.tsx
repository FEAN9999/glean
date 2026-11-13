import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtBytes } from '../lib/format';
import { SudoGate } from '../components/SudoGate';
import { Switch, useUi } from '../components/ui';

type Cfg = any;

function getPath(o: any, p: string) {
  return p.split('.').reduce((a, k) => a?.[k], o);
}
function setPath(o: any, p: string, v: unknown) {
  const copy = structuredClone(o);
  const keys = p.split('.');
  let cur = copy;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys.at(-1)!] = v;
  return copy;
}

function Section({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <fieldset id={id}>
      <legend>{title}</legend>
      {desc && <p>{desc}</p>}
      <div className="stack">{children}</div>
    </fieldset>
  );
}

interface ForumNode {
  id: number;
  name: string;
  group: string | null;
  depth: number;
}

/** Reads the forum's home page and lets the user tick the sections to sync. */
function ForumPicker({
  baseUrl,
  current,
  onApply,
}: {
  baseUrl: string;
  current: { id: number; name: string }[];
  onApply: (list: { id: number; name: string }[]) => void;
}) {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<ForumNode[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const discover = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.get<ForumNode[]>(`/systems/discover-forums?baseUrl=${encodeURIComponent(baseUrl)}`, { quiet: true });
      setNodes(r.data);
      const known = new Set(current.map((f) => f.id));
      setPicked(new Set(r.data.filter((n) => known.has(n.id)).map((n) => n.id)));
    } catch (err) {
      setError((err as ApiErr).message);
      setNodes(null);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const groups = nodes ? [...new Set(nodes.map((n) => (n.depth ? null : n.group)).filter((g) => g !== undefined))] : [];

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="hstack">
        <button type="button" className="btn btn-sm" onClick={() => void discover()} disabled={busy || !baseUrl}>
          {busy ? t('Đang đọc trang chủ diễn đàn…', 'Reading the forum home page…') : t('Lấy chuyên mục từ diễn đàn', 'Fetch sections from the forum')}
        </button>
        {nodes && (
          <span className="muted" style={{ fontSize: 13.5 }}>
            {t(`Tìm thấy ${nodes.length} chuyên mục, đã chọn ${picked.size}.`, `Found ${nodes.length} sections, ${picked.size} selected.`)}
          </span>
        )}
      </div>
      {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
      {nodes && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
          <div className="hstack" style={{ marginBottom: 12 }}>
            <button type="button" className="link-btn" style={{ fontSize: 13.5 }} onClick={() => setPicked(new Set(nodes.map((n) => n.id)))}>
              {t('Chọn tất cả', 'Select all')}
            </button>
            <button type="button" className="link-btn" style={{ fontSize: 13.5 }} onClick={() => setPicked(new Set())}>
              {t('Bỏ chọn tất cả', 'Clear selection')}
            </button>
          </div>
          <div className="stack" style={{ gap: 14 }}>
            {groups.map((g) => (
              <div key={g ?? '_'} className="stack" style={{ gap: 6 }}>
                {g && <strong style={{ fontSize: 13.5, fontWeight: 600 }}>{g}</strong>}
                {nodes
                  .filter((n) => n.depth === 0 && n.group === g)
                  .map((n) => (
                    <div key={n.id} className="stack" style={{ gap: 4 }}>
                      <label className="check">
                        <input type="checkbox" checked={picked.has(n.id)} onChange={(e) => toggle(n.id, e.target.checked)} />
                        {n.name} <span className="muted" style={{ fontSize: 12.5 }}>#{n.id}</span>
                      </label>
                      {nodes
                        .filter((s) => s.depth > 0 && s.group === n.name)
                        .map((s) => (
                          <label key={s.id} className="check" style={{ marginLeft: 26 }}>
                            <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                            {s.name} <span className="muted" style={{ fontSize: 12.5 }}>#{s.id}</span>
                          </label>
                        ))}
                    </div>
                  ))}
              </div>
            ))}
          </div>
          <div className="hstack" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!picked.size}
              onClick={() => {
                onApply(nodes.filter((n) => picked.has(n.id)).map((n) => ({ id: n.id, name: n.name })));
                setNodes(null);
              }}
            >
              {t(`Dùng ${picked.size} chuyên mục đã chọn`, `Use ${picked.size} selected sections`)}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              {t('Thay danh sách ở trên. Nhớ bấm "Lưu cài đặt".', 'Replaces the list above. Remember to save.')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Inner() {
  const { t } = useI18n();
  const { toast, refreshMaintenance } = useUi();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState<any>(null);
  const [proxy, setProxy] = useState<any>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.get('/systems/config', { quiet: true }).then((r) => {
      setCfg(r.data);
      setSaved(JSON.stringify(r.data));
    });
    api.get('/systems/environment', { quiet: true }).then((r) => setEnv(r.data)).catch(() => {});
  }, []);

  // Deep links such as /cai-dat#sync: scroll once the form exists.
  const ready = !!cfg;
  useEffect(() => {
    if (!ready || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [ready]);

  if (!cfg) return null;
  const dirty = JSON.stringify(cfg) !== saved;
  const set = (p: string, v: unknown) => setCfg((c: Cfg) => setPath(c, p, v));

  const Text = ({ p, label, hint, type = 'text', placeholder }: { p: string; label: string; hint?: string; type?: string; placeholder?: string }) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" type={type} value={getPath(cfg, p) ?? ''} placeholder={placeholder} onChange={(e) => set(p, e.target.value)} autoComplete="off" />
      {hint && <small>{hint}</small>}
    </label>
  );
  const Num = ({ p, label, hint, min = 0, scale = 1 }: { p: string; label: string; hint?: string; min?: number; scale?: number }) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="number" min={min} value={Math.round((getPath(cfg, p) ?? 0) / scale)} onChange={(e) => set(p, Number(e.target.value) * scale)} />
      {hint && <small>{hint}</small>}
    </label>
  );
  const Bool = ({ p, label }: { p: string; label: string }) => <Switch key={p} label={label} checked={!!getPath(cfg, p)} onChange={(v) => set(p, v)} />;
  const Lines = ({ p, label, hint, placeholder }: { p: string; label: string; hint?: string; placeholder?: string }) => (
    <label className="field">
      <span>{label}</span>
      <textarea
        className="textarea"
        value={(getPath(cfg, p) ?? []).join('\n')}
        placeholder={placeholder}
        onChange={(e) =>
          set(
            p,
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter((s, i, arr) => s || i === arr.length - 1),
          )
        }
        onBlur={(e) =>
          set(
            p,
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
      {hint && <small>{hint}</small>}
    </label>
  );

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.put('/systems/config', cfg, { quiet: true });
      setCfg(r.data);
      setSaved(JSON.stringify(r.data));
      refreshMaintenance();
      toast(t('Đã lưu cài đặt. Thay đổi có hiệu lực ngay.', 'Settings saved. Changes apply immediately.'));
    } catch (err) {
      setError((err as ApiErr).message);
    } finally {
      setBusy(false);
    }
  };
  const reloadFromDb = async () => {
    const r = await api.post('/systems/reload-config');
    setCfg(r.data);
    setSaved(JSON.stringify(r.data));
    toast(t('Đã nạp lại cấu hình từ cơ sở dữ liệu.', 'Configuration reloaded from the database.'));
  };

  const nav = [
    ['src', t('Nguồn dữ liệu', 'Source')],
    ['sync', t('Đồng bộ', 'Sync')],
    ['sieve', t('Sàng', 'Sieve')],
    ['proxy', 'Proxy'],
    ['storage', t('Lưu trữ tệp', 'File storage')],
    ['search', t('Tìm kiếm', 'Search')],
    ['ai', 'AI'],
    ['auth', t('Phiên đăng nhập', 'Sessions')],
    ['tg', 'Telegram'],
    ['pause', t('Tạm dừng tính năng', 'Pause features')],
    ['broadcast', t('Thông báo & phiên bản', 'Notices & version')],
  ];

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Cài đặt', 'Settings')}</h1>
        <p className="page-lede">{t('Mọi thay đổi được lưu vào cơ sở dữ liệu và áp dụng ngay, không cần khởi động lại.', 'Every change is stored in the database and applied at once, no restart needed.')}</p>
      </header>
      <div className="settings">
        <nav className="settings-nav" aria-label={t('Mục cài đặt', 'Settings sections')}>
          {nav.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className="settings-body">
          <Section id="src" title={t('Nguồn dữ liệu', 'Source')} desc={t('Diễn đàn kiểu XenForo mà Glean đọc. Mặc định là diễn đàn mẫu chạy sẵn trong máy để thử.', 'The XenForo-style forum Glean reads. By default this is the built-in sample forum.')}>
            {Text({ p: 'source.baseUrl', label: t('Địa chỉ diễn đàn', 'Forum address'), hint: t('Khi đổi tên miền, địa chỉ cũ được ghi nhớ để cảnh báo link cũ.', 'When the domain changes, the old one is remembered to flag old links.') })}
            {Lines({ p: 'source.previousBaseUrls', label: t('Tên miền cũ', 'Previous domains'), hint: t('Mỗi dòng một địa chỉ.', 'One address per line.') })}
            <div className="field">
              <span>{t('Chuyên mục cần đồng bộ', 'Sections to sync')}</span>
              <div className="stack" style={{ gap: 8 }}>
                {cfg.source.forums.map((f: { id: number; name: string }, i: number) => (
                  <div key={i} className="hstack" style={{ flexWrap: 'nowrap' }}>
                    <input
                      className="input"
                      style={{ width: 96 }}
                      type="number"
                      aria-label={t('ID chuyên mục', 'Section ID')}
                      value={f.id}
                      onChange={(e) => set(`source.forums.${i}.id`, Number(e.target.value))}
                    />
                    <input className="input" aria-label={t('Tên chuyên mục', 'Section name')} value={f.name} onChange={(e) => set(`source.forums.${i}.name`, e.target.value)} />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-danger"
                      onClick={() =>
                        set(
                          'source.forums',
                          cfg.source.forums.filter((_: unknown, j: number) => j !== i),
                        )
                      }
                    >
                      {t('Bỏ', 'Remove')}
                    </button>
                  </div>
                ))}
                <div>
                  <button type="button" className="btn btn-sm" onClick={() => set('source.forums', [...cfg.source.forums, { id: 0, name: '' }])}>
                    {t('Thêm chuyên mục', 'Add section')}
                  </button>
                </div>
              </div>
            </div>
            {JSON.parse(saved).source.baseUrl !== cfg.source.baseUrl && (
              <div className="notice notice-straw">
                {t(
                  'Bạn vừa đổi địa chỉ diễn đàn. ID chuyên mục của diễn đàn cũ thường không đúng với diễn đàn mới: hãy lấy lại danh sách bên dưới trước khi lưu.',
                  'You changed the forum address. Section IDs from the old forum rarely match the new one: fetch the list below before saving.',
                )}
              </div>
            )}
            <ForumPicker baseUrl={cfg.source.baseUrl} current={cfg.source.forums} onApply={(list) => set('source.forums', list)} />
            <div className="form-grid">
              {Num({ p: 'source.postsPerPage', label: t('Bài mỗi trang của diễn đàn', 'Posts per forum page'), min: 1 })}
              {Num({ p: 'source.requestTimeoutMs', label: t('Thời gian chờ (giây)', 'Request timeout (s)'), scale: 1000, min: 1 })}
            </div>
            {Text({ p: 'source.userAgent', label: 'User-Agent' })}
          </Section>

          <Section id="sync" title={t('Đồng bộ tự động', 'Auto-sync')} desc={t('Định kỳ quét các trang mới nhất của từng chuyên mục và nạp vào kho tìm kiếm.', 'Periodically scans the newest pages of each section into the search archive.')}>
            {Bool({ p: 'sync.posts.enabled', label: t('Đồng bộ bài viết', 'Sync threads') })}
            <div className="form-grid">
              {Num({ p: 'sync.posts.pagesPerRun', label: t('Số trang mỗi lượt', 'Pages per run'), min: 1 })}
              {Num({ p: 'sync.posts.intervalMs', label: t('Chu kỳ (phút)', 'Every (minutes)'), scale: 60000, min: 1 })}
            </div>
            {Bool({ p: 'sync.comments.enabled', label: t('Đồng bộ bình luận', 'Sync comments') })}
            <div className="form-grid">
              {Num({ p: 'sync.comments.pagesPerRun', label: t('Số trang mỗi bài mỗi lượt', 'Pages per thread per run'), min: 1 })}
              {Num({ p: 'sync.comments.intervalMs', label: t('Chu kỳ (phút)', 'Every (minutes)'), scale: 60000, min: 1 })}
              {Num({ p: 'sync.comments.maxThreadsPerRun', label: t('Số bài tối đa mỗi lượt', 'Max threads per run'), min: 1 })}
              {Num({
                p: 'sync.comments.recheckPages',
                label: t('Đọc lại số trang cuối (0 = tắt)', 'Re-read last pages (0 = off)'),
                hint: t('Để phát hiện bình luận bị sửa/xóa; mỗi trang thêm một lượt tải.', 'Catches edited/deleted comments; each page is one more request.'),
                min: 0,
              })}
              {Num({ p: 'sync.comments.recheckWithinHours', label: t('Đọc lại bài có hoạt động trong (giờ)', 'Re-read threads active within (hours)'), min: 1 })}
            </div>
            {Text({ p: 'sync.commentServiceUrl', label: t('Địa chỉ dịch vụ bình luận (tùy chọn)', 'Comment service URL (optional)'), placeholder: 'http://…' })}
          </Section>

          <Section id="sieve" title={t('Sàng ảnh', 'Sieve')}>
            <div className="form-grid">
              {Num({ p: 'scraper.concurrentPages', label: t('Số trang quét cùng lúc', 'Pages in parallel'), min: 1 })}
              {Num({ p: 'scraper.concurrentImageDownloads', label: t('Số ảnh tải cùng lúc', 'Images in parallel'), min: 1 })}
              {Num({ p: 'scraper.batchDelayMs', label: t('Nghỉ giữa các đợt (ms)', 'Pause between batches (ms)') })}
              {Num({ p: 'scraper.minCommentLength', label: t('Độ dài bình luận tối thiểu', 'Minimum comment length') })}
              {Num({ p: 'scraper.retentionHours', label: t('Tự xóa sau (giờ)', 'Auto-delete after (hours)'), hint: t('0 là giữ mãi.', '0 keeps forever.') })}
            </div>
            {Bool({ p: 'scraper.downloadImages', label: t('Tải ảnh về máy', 'Download images') })}
            {Bool({ p: 'scraper.downloadVideos', label: t('Tải tệp video về máy (không áp dụng cho video nhúng)', 'Download video files (not embeds)') })}
            {Lines({ p: 'scraper.ignoredDomains', label: t('Bỏ qua ảnh từ các tên miền', 'Ignore images from domains'), hint: t('Mỗi dòng một tên miền, gồm cả tên miền con.', 'One domain per line, subdomains included.') })}
          </Section>

          <Section id="proxy" title="Proxy" desc={t('Xoay vòng proxy khi đọc diễn đàn. Proxy lỗi 3 lần liên tiếp bị tạm ngưng tới lần kiểm tra sau.', 'Rotates proxies when reading the forum. A proxy failing 3 times in a row is parked until the next check.')}>
            {Bool({ p: 'proxy.enabled', label: t('Dùng proxy', 'Use proxies') })}
            {Lines({ p: 'proxy.list', label: t('Danh sách proxy', 'Proxy list'), placeholder: 'host:port:user:pass', hint: t('Mỗi dòng: host:port hoặc host:port:user:pass', 'One per line: host:port or host:port:user:pass') })}
            {Text({ p: 'proxy.healthCheckUrl', label: t('Địa chỉ kiểm tra', 'Health-check URL'), hint: t('Để trống sẽ dùng địa chỉ diễn đàn.', 'Empty uses the forum address.') })}
            <div className="hstack">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => api.get('/scrapes/check-proxy?refresh=1').then((r) => setProxy(r.data))}
              >
                {t('Kiểm tra proxy ngay', 'Check proxies now')}
              </button>
              {proxy && (
                <span className="muted" style={{ fontSize: 14 }}>
                  {proxy.enabled ? t(`${proxy.alive}/${proxy.total} proxy hoạt động`, `${proxy.alive}/${proxy.total} proxies working`) : t('Proxy đang tắt (sau khi lưu).', 'Proxies are off (as saved).')}
                </span>
              )}
            </div>
          </Section>

          <Section id="storage" title={t('Lưu trữ tệp', 'File storage')}>
            {Text({ p: 'storage.basePath', label: t('Thư mục lưu', 'Base folder') })}
            <div className="form-grid">
              {Text({ p: 'storage.thumbnailDir', label: t('Thư mục ảnh thu nhỏ', 'Thumbnail folder') })}
              {Num({ p: 'storage.maxFileSizeMb', label: t('Kích thước tối đa (MB)', 'Max size (MB)'), min: 1 })}
              {Num({ p: 'storage.chunkSizeMb', label: t('Kích thước mỗi phần tải lên (MB)', 'Upload chunk (MB)'), min: 1 })}
              {Num({ p: 'storage.concurrentUploads', label: t('Tải lên đồng thời', 'Parallel uploads'), min: 1 })}
            </div>
            {Bool({ p: 'storage.transcodeVideoToHls', label: t('Chuyển video sang HLS bằng FFmpeg', 'Transcode video to HLS with FFmpeg') })}
            {Text({ p: 'storage.ffmpegPath', label: t('Đường dẫn FFmpeg', 'FFmpeg path') })}
            {env && (
              <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
                {env.ffmpeg ? t('Đã tìm thấy FFmpeg trên máy.', 'FFmpeg found on this machine.') : t('Không tìm thấy FFmpeg; video sẽ giữ nguyên định dạng.', 'FFmpeg not found; videos keep their original format.')}{' '}
                {t(`Cơ sở dữ liệu: ${fmtBytes(env.dbSizeBytes)}.`, `Database: ${fmtBytes(env.dbSizeBytes)}.`)}
              </p>
            )}
          </Section>

          <Section id="search" title={t('Tìm kiếm', 'Search')} desc={t('Kho tìm kiếm là SQLite FTS5 (không phân biệt dấu khi "chứa các từ"). Gợi ý liên quan dùng dịch vụ semantic nếu có, nếu không thì so khớp từ.', 'The archive uses SQLite FTS5 (accent-insensitive for "contains words"). Related suggestions use a semantic service when set, else word overlap.')}>
            {Text({ p: 'search.semanticSearchUrl', label: t('Địa chỉ dịch vụ semantic (tùy chọn)', 'Semantic service URL (optional)'), placeholder: 'http://localhost:8000' })}
            <div className="form-grid">
              {Num({ p: 'search.semanticTopK', label: t('Số gợi ý', 'Suggestions'), min: 1 })}
              {Num({ p: 'search.pageSize', label: t('Kết quả mỗi trang', 'Results per page'), min: 5 })}
              {Num({ p: 'search.minKeywordLength', label: t('Số ký tự tối thiểu', 'Minimum characters'), min: 1 })}
            </div>
          </Section>

          <Section id="ai" title="AI" desc={t('Lưu sẵn khóa API. Hiện chưa có tính năng nào dùng tới.', 'Stores API keys. No feature uses them yet.')}>
            {Bool({ p: 'ai.chatGpt.enabled', label: 'ChatGPT' })}
            {Text({ p: 'ai.chatGpt.apiKey', label: t('Khóa API ChatGPT', 'ChatGPT API key'), type: 'password' })}
            {Bool({ p: 'ai.gemini.enabled', label: 'Gemini' })}
            {Text({ p: 'ai.gemini.apiKey', label: t('Khóa API Gemini', 'Gemini API key'), type: 'password' })}
          </Section>

          <Section id="auth" title={t('Phiên đăng nhập', 'Sessions')} desc={t('Đổi khóa bí mật sẽ đăng xuất mọi thiết bị.', 'Changing the secret signs out every device.')}>
            <div className="form-grid">
              {Text({ p: 'auth.issuer', label: 'Issuer' })}
              {Text({ p: 'auth.audience', label: 'Audience' })}
              {Num({ p: 'auth.accessTokenMinutes', label: t('Hạn token truy cập (phút)', 'Access token (minutes)'), min: 1 })}
              {Num({ p: 'auth.refreshTokenDays', label: t('Hạn phiên (ngày)', 'Session (days)'), min: 1 })}
            </div>
            {Text({ p: 'auth.secret', label: t('Khóa bí mật JWT', 'JWT secret'), type: 'password' })}
          </Section>

          <Section id="tg" title="Telegram" desc={t('Gửi tin khi một lượt sàng xong hoặc đồng bộ lỗi.', 'Sends a message when a sieve job finishes or a sync fails.')}>
            {Bool({ p: 'telegram.enabled', label: t('Bật thông báo Telegram', 'Enable Telegram notices') })}
            <div className="form-grid">
              {Text({ p: 'telegram.botToken', label: 'Bot token', type: 'password' })}
              {Text({ p: 'telegram.chatId', label: 'Chat ID' })}
            </div>
            {Bool({ p: 'telegram.notifyScrapeFinished', label: t('Khi sàng xong', 'When a sieve job finishes') })}
            {Bool({ p: 'telegram.notifySyncFailed', label: t('Khi đồng bộ lỗi', 'When a sync fails') })}
            <div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={dirty}
                title={dirty ? t('Lưu trước khi gửi thử', 'Save before testing') : undefined}
                onClick={() =>
                  api
                    .post('/systems/test-telegram')
                    .then(() => toast(t('Đã gửi tin thử.', 'Test message sent.')))
                    .catch(() => {})
                }
              >
                {t('Gửi tin thử', 'Send test message')}
              </button>
            </div>
          </Section>

          <Section id="pause" title={t('Tạm dừng tính năng', 'Pause features')} desc={t('Dùng khi diễn đàn nguồn lỗi hoặc đang đồng bộ lớn. Thông điệp hiện trên trang tương ứng.', 'For when the source forum is down or a large sync is running. The message shows on the affected page.')}>
            {(
              [
                ['scrape', t('Sàng ảnh', 'Sieve')],
                ['searchPost', t('Tìm bài viết', 'Post search')],
                ['searchComment', t('Tìm bình luận', 'Comment search')],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="stack" style={{ gap: 8 }}>
                {Bool({ p: `maintenance.${k}.isPaused`, label: t(`Tạm dừng ${label.toLowerCase()}`, `Pause ${label.toLowerCase()}`) })}
                {getPath(cfg, `maintenance.${k}.isPaused`) && Text({ p: `maintenance.${k}.message`, label: t('Thông điệp', 'Message') })}
              </div>
            ))}
          </Section>

          <fieldset id="broadcast">
            <legend>{t('Thông báo & phiên bản', 'Notices & version')}</legend>
            <p>{t('Gửi tới mọi thẻ trình duyệt đang mở Glean.', 'Sent to every browser tab that has Glean open.')}</p>
            <div className="stack">
              <label className="field">
                <span>{t('Thông báo hệ thống', 'System notice')}</span>
                <input className="input" value={notice} onChange={(e) => setNotice(e.target.value)} placeholder={t('Ví dụ: đang đồng bộ lớn, tìm kiếm có thể chậm', 'e.g. large sync running, search may be slow')} />
              </label>
              <div className="hstack">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!notice.trim()}
                  onClick={() =>
                    api.post('/systems/notify', { message: notice }).then((r) => {
                      setNotice('');
                      toast(t(`Đã gửi tới ${r.data.delivered} thẻ.`, `Sent to ${r.data.delivered} tabs.`));
                    })
                  }
                >
                  {t('Gửi thông báo', 'Send notice')}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => api.post('/systems/force-reload').then(() => {})}>
                  {t('Yêu cầu mọi thẻ tải lại', 'Ask every tab to reload')}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void reloadFromDb()}>
                  {t('Nạp lại cấu hình', 'Reload configuration')}
                </button>
              </div>
              {env && (
                <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
                  {t(`Phiên bản ${env.version}, Node ${env.node}, ${env.realtimeClients} kết nối trực tiếp.`, `Version ${env.version}, Node ${env.node}, ${env.realtimeClients} live connections.`)}
                </p>
              )}
            </div>
          </fieldset>

          <div className="savebar">
            <button className="btn btn-primary btn-lg" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? t('Đang lưu…', 'Saving…') : t('Lưu cài đặt', 'Save settings')}
            </button>
            {dirty && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setCfg(JSON.parse(saved));
                  setError('');
                }}
              >
                {t('Bỏ thay đổi', 'Discard changes')}
              </button>
            )}
            <span className="muted" style={{ fontSize: 13.5 }}>
              {dirty ? t('Có thay đổi chưa lưu.', 'Unsaved changes.') : t('Đã lưu.', 'Saved.')}
            </span>
            {error && <span className="error-text" style={{ margin: 0 }}>{error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  return (
    <SudoGate title={t('Cài đặt', 'Settings')}>
      <Inner />
    </SudoGate>
  );
}
