import { StrictMode } from 'react';
import { MotionConfig } from 'motion/react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './app.css';
import { I18nProvider, useI18n } from './lib/i18n';
import { AuthProvider, useAuth } from './lib/auth';
import { UiProvider } from './components/ui';
import { Shell, initTheme } from './components/Shell';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { HomePage } from './pages/Home';
import { SearchPage } from './pages/Search';
import { QueuePage, SievePage } from './pages/Sieve';
import { SieveDetailPage } from './pages/SieveDetail';
import { SyncLogDetailPage, SyncLogPage } from './pages/Logs';
import { ManualSyncPage } from './pages/ManualSync';
import { SettingsPage } from './pages/Settings';
import { BackupPage } from './pages/Backup';
import { ProfilePage } from './pages/Profile';
import { Empty, PageErrorBoundary } from './components/ui';
import { SingleSiteOnly } from './lib/site';

initTheme();

/** Another job id is another job: start the page fresh instead of keeping the previous job's state. */
function SieveDetailRoute() {
  return <SieveDetailPage key={useParams().id} />;
}

function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page">
      <Empty page title={t('Không có trang này', 'Page not found')}>
        <a href="/" className="link-btn">
          {t('Về bàn làm việc', 'Back to the desk')}
        </a>
      </Empty>
    </div>
  );
}

function App() {
  const { status } = useAuth();
  const { pathname } = useLocation();
  if (status === 'loading') return null;
  if (status === 'setup') return <SetupPage />;
  if (status === 'anon') return <LoginPage />;
  return (
    <UiProvider>
      <Shell>
        <PageErrorBoundary resetKey={pathname}>
        <Routes>
          <Route path="/" element={<SingleSiteOnly><HomePage /></SingleSiteOnly>} />
          <Route path="/bai-viet" element={<Navigate to="/bai-viet/tu-khoa" replace />} />
          <Route path="/bai-viet/:mode" element={<SearchPage key="posts" scope="posts" />} />
          <Route path="/binh-luan" element={<Navigate to="/binh-luan/tu-khoa" replace />} />
          <Route path="/binh-luan/:mode" element={<SearchPage key="comments" scope="comments" />} />
          <Route path="/sang" element={<SievePage />} />
          <Route path="/sang/:id" element={<SieveDetailRoute />} />
          <Route path="/hang-doi" element={<SingleSiteOnly><QueuePage /></SingleSiteOnly>} />
          <Route path="/nhat-ky" element={<Navigate to="/nhat-ky/bai-viet" replace />} />
          <Route path="/nhat-ky/bai-viet" element={<SingleSiteOnly><SyncLogPage kind="posts" /></SingleSiteOnly>} />
          <Route path="/nhat-ky/bai-viet/:id" element={<SingleSiteOnly><SyncLogDetailPage kind="posts" /></SingleSiteOnly>} />
          <Route path="/nhat-ky/binh-luan" element={<SingleSiteOnly><SyncLogPage kind="comments" /></SingleSiteOnly>} />
          <Route path="/nhat-ky/binh-luan/:id" element={<SingleSiteOnly><SyncLogDetailPage kind="comments" /></SingleSiteOnly>} />
          <Route path="/dong-bo" element={<SingleSiteOnly><ManualSyncPage /></SingleSiteOnly>} />
          <Route path="/cai-dat" element={<SingleSiteOnly><SettingsPage /></SingleSiteOnly>} />
          <Route path="/sao-luu" element={<BackupPage />} />
          <Route path="/ho-so" element={<ProfilePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </PageErrorBoundary>
      </Shell>
    </UiProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Anyone who asked the system for less motion gets the end state at once. */}
    <MotionConfig reducedMotion="user">
      <I18nProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </MotionConfig>
  </StrictMode>,
);
