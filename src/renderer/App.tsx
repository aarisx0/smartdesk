import { Routes, Route, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Activity from './pages/Activity';
import Analytics from './pages/Analytics';
import Duplicates from './pages/Duplicates';
import Settings from './pages/Settings';
import Approvals from './pages/Approvals';
import Chat from './pages/Chat';

export default function App() {
  const location = useLocation();

  return (
    <Routes location={location} key={location.pathname}>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/duplicates" element={<Duplicates />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
