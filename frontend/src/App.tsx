import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AuthPage from './pages/Auth';
import DashboardPage from './pages/Dashboard';
import DaniTestPage from './pages/DaniTest';
import BlingPage from './pages/Bling';
import WhatsAppPage from './pages/WhatsApp';
import ConversationsPage from './pages/Conversations';
import ConversationDetailPage from './pages/ConversationDetail';
import CloudinaryPage from './pages/Cloudinary';
import PipelinePage from './pages/Pipeline';
import AppointmentsPage from './pages/Appointments';
import AgentSettingsPage from './pages/AgentSettings';
import KnowledgePage from './pages/Knowledge';
import LibraryPage from './pages/Library';
import OnboardingPage from './pages/Onboarding';
import PerfilPage from './pages/Perfil';
import RequireAdmin from './components/RequireAdmin';
import AdminUsersPage from './pages/AdminUsers';
import TokenCostPage from './pages/TokenCost';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Publicas / cliente */}
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/conversations/:id" element={<ConversationDetailPage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/appointments" element={<AppointmentsPage />} />
        <Route path="/perfil" element={<PerfilPage />} />

        {/* Teste de chat: liberado pro cliente (manager/sdr) tambem.
            A validacao por-conta e feita no backend (assertAccountMember). */}
        <Route path="/dani" element={<DaniTestPage />} />

        {/* Admin-only — AX team (owner/admin/superadmin) */}
        <Route
          path="/agent"
          element={
            <RequireAdmin>
              <AgentSettingsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/knowledge"
          element={
            <RequireAdmin>
              <KnowledgePage />
            </RequireAdmin>
          }
        />
        <Route
          path="/library"
          element={
            <RequireAdmin>
              <LibraryPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/onboarding"
          element={
            <RequireAdmin>
              <OnboardingPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/bling"
          element={
            <RequireAdmin>
              <BlingPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/whatsapp"
          element={
            <RequireAdmin>
              <WhatsAppPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/cloudinary"
          element={
            <RequireAdmin>
              <CloudinaryPage />
            </RequireAdmin>
          }
        />

        {/* Super-admin only */}
        <Route
          path="/admin/users"
          element={
            <RequireAdmin>
              <AdminUsersPage />
            </RequireAdmin>
          }
        />
        <Route path="/admin/token-cost" element={<TokenCostPage />} />

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
