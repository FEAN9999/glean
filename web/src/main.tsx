import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
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
import { Empty } from './components/ui';

initTheme();

function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page">
      <Empty title={t('Không có trang này', 'Page not found')}>
        <a href="/" className="link-btn">
          {t('Về bàn làm việc', 'Back to the desk')}
        </a>
      </Empty>
    </div>
  );
}

function App() {
  const { status } = useAuth();
  if (status === 'loading') return null;
  if (status === 'setup') return <SetupPage />;
  if (status === 'anon') return <LoginPage />;
  return (
    <UiProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/bai-viet" element={<Navigate to="/bai-viet/tu-khoa" replace />} />
          <Route path="/bai-viet/:mode" element={<SearchPage key="posts" scope="posts" />} />
          <Route path="/binh-luan" element={<Navigate to="/binh-luan/tu-khoa" replace />} />
          <Route path="/binh-luan/:mode" element={<SearchPage key="comments" scope="comments" />} />
          <Route path="/sang" element={<SievePage />} />
          <Route path="/sang/:id" element={<SieveDetailPage />} />
          <Route path="/hang-doi" element={<QueuePage />} />
          <Route path="/nhat-ky" element={<Navigate to="/nhat-ky/bai-viet" replace />} />
          <Route path="/nhat-ky/bai-viet" element={<SyncLogPage kind="posts" />} />
          <Route path="/nhat-ky/bai-viet/:id" element={<SyncLogDetailPage kind="posts" />} />
          <Route path="/nhat-ky/binh-luan" element={<SyncLogPage kind="comments" />} />
          <Route path="/nhat-ky/binh-luan/:id" element={<SyncLogDetailPage kind="comments" />} />
          <Route path="/dong-bo" element={<ManualSyncPage />} />
          <Route path="/cai-dat" element={<SettingsPage />} />
          <Route path="/sao-luu" element={<BackupPage />} />
          <Route path="/ho-so" element={<ProfilePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Shell>
    </UiProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
);
