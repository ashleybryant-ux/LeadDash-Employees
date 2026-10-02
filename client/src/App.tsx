import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Redirect, Route, Switch } from "wouter";
import { Loader2 } from "lucide-react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { TenantProvider, useTenant } from "./contexts/TenantContext";
import { useAuth } from "./_core/hooks/useAuth";
import SignIn from "./pages/SignIn";
import ChatPage from "./ld/ChatPage";
import Approvals from "./ld/pages/Approvals";
import Tasks from "./ld/pages/Tasks";
import Brain from "./ld/pages/Brain";
import Workspace from "./ld/pages/Workspace";
import Integrations from "./ld/pages/Integrations";
import Team from "./ld/pages/Team";
import { Rail, Switcher } from "./ld/ui";
import "./ld/theme.css";

function NoWorkspace() {
  const { user } = useAuth();
  return (
    <div className="ld">
      <Rail active="chats" />
      <main className="ld-main" style={{ maxWidth: 560 }}>
        <h1 className="ld-h1">No workspace yet</h1>
        <p className="ld-body">
          {user?.role === "admin" ? "Create the first workspace to get your seven employees." : "Ask your workspace owner to add you."}
        </p>
        {user?.role === "admin" && <Switcher onClose={() => {}} />}
      </main>
    </div>
  );
}

function Router() {
  const { organizations, isLoading } = useTenant();
  if (isLoading) return <Spinner />;
  if (organizations.length === 0) return <NoWorkspace />;
  return (
    <Switch>
      <Route path="/">{() => <Redirect to="/chats" />}</Route>
      <Route path="/chats" component={ChatPage} />
      <Route path="/chats/e/:id/:tab?" component={ChatPage} />
      <Route path="/chats/:kind/:tab?" component={ChatPage} />
      <Route path="/approvals" component={Approvals} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/brain" component={Brain} />
      <Route path="/workspace" component={Workspace} />
      <Route path="/integrations" component={Integrations} />
      <Route path="/team" component={Team} />
      <Route>{() => <Redirect to="/chats" />}</Route>
    </Switch>
  );
}

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#f8fafb" }}>
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
    </div>
  );
}

/** Nothing inside the app loads until the person has signed in. */
function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <SignIn />;
  return (
    <TenantProvider>
      <Router />
    </TenantProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="top-right" richColors />
          <Gate />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
