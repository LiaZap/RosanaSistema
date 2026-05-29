import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AuthPage from './pages/Auth';
import DashboardPage from './pages/Dashboard';
import DaniTestPage from './pages/DaniTest';
import BlingPage from './pages/Bling';
import WhatsAppPage from './pages/WhatsApp';
import ConversationsPage from './pages/Conversations';
import ConversationDetailPage from './pages/ConversationDetail';
import CloudinaryPage from './pages/Cloudinary';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/dani" element={<DaniTestPage />} />
        <Route path="/bling" element={<BlingPage />} />
        <Route path="/whatsapp" element={<WhatsAppPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/conversations/:id" element={<ConversationDetailPage />} />
        <Route path="/cloudinary" element={<CloudinaryPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
