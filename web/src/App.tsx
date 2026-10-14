import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Logo } from "./components/ui";
import { useAuth } from "./lib/auth";
import AuthPage from "./pages/AuthPage";
import Find from "./pages/Find";
import Home from "./pages/Home";
import Notifications from "./pages/Notifications";
import TaskWork from "./pages/TaskWork";
import Landing from "./pages/Landing";
import ProjectPage from "./pages/ProjectPage";
import ProjectsPage from "./pages/ProjectsPage";
import Profile from "./pages/Profile";
import PayReturn from "./pages/PayReturn";
import Earnings from "./pages/Earnings";
import Admin from "./pages/Admin";
import Plan from "./pages/Plan";
import DisputePage from "./pages/Dispute";
import Settings from "./pages/Settings";
import Safety from "./pages/Safety";
import Schedule from "./pages/Schedule";
import Assets from "./pages/Assets";
import TrustPage from "./pages/Trust";
import Organisation from "./pages/Organisation";
import MerchantPage from "./pages/Merchant";
import Shop from "./pages/Shop";
import Programmes from "./pages/Programmes";
import Insights from "./pages/Insights";
import Templates from "./pages/Templates";
import AdminConsole from "./pages/AdminConsole";
import More from "./pages/More";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

/** After signing in, go back to where the person was heading, or home. */
function AfterAuth() {
  const from = (useLocation().state as { from?: string } | null)?.from;
  return <Navigate to={from && from !== "/auth" ? from : "/"} replace />;
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="grid min-h-screen place-items-center"><div className="animate-pulse"><Logo className="h-14 w-14" /></div></div>;
  }

  if (!user) {
    return (
      <>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="*" element={<Navigate to="/auth" replace state={{ from: location.pathname }} />} />
        </Routes>
      </>
    );
  }

  return (
    <Shell>
      <ScrollToTop />
      <div key={location.pathname} className="page-in">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/find" element={<Find />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/projects/:projectId/tasks/:taskId" element={<TaskWork />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/pay/return" element={<PayReturn />} />
          <Route path="/earnings" element={<Earnings />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/plan" element={<Plan />} />
          <Route path="/disputes/:id" element={<DisputePage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/safety" element={<Safety />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/trust" element={<TrustPage />} />
          <Route path="/org" element={<Organisation />} />
          <Route path="/merchant" element={<MerchantPage />} />
          <Route path="/shop" element={<Shop />} />
          <Route path="/programmes" element={<Programmes />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/admin/console" element={<AdminConsole />} />
          <Route path="/more" element={<More />} />
          <Route path="/auth" element={<AfterAuth />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </Shell>
  );
}
