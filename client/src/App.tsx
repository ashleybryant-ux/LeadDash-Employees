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
import TeamChatPage from "./ld/TeamChat";
import TeamSearchPage from "./ld/team/Search";
import TeamViewPage from "./ld/team/Views";
import SlackImportPage from "./ld/team/Import";
import Approvals from "./ld/pages/Approvals";
import Huddle from "./ld/pages/Huddle";
import Activity from "./ld/pages/Activity";
import Tasks from "./ld/pages/Tasks";
import Calendar from "./ld/pages/Calendar";
import Goals from "./ld/pages/Goals";
import Projects from "./ld/pages/Projects";
import Brain from "./ld/pages/Brain";
import Workspace from "./ld/pages/Workspace";
import Integrations from "./ld/pages/Integrations";
import Team from "./ld/pages/Team";
import Account from "./ld/pages/Account";
import More from "./ld/pages/More";
import Handbook from "./ld/pages/Handbook";
import SopPage from "./ld/sops/SopPage";
import BaseInstructions from "./ld/pages/BaseInstructions";
import { Rail, Switcher } from "./ld/ui";
import Notices from "./ld/Notices";
import "./ld/theme.css";
import { useEffect } from "react";

function NoWorkspace() {
  const { user } = useAuth();
  return (
    <div className="ld">
      <Rail active="chats" />
      <main className="ld-main" style={{ maxWidth: 560 }}>
        <h1 className="ld-h1">No workspace yet</h1>
        <p className="ld-body">
          {user?.role === "admin" ? "Create the first workspace to get your employees." : "Ask your workspace owner to add you."}
        </p>
        {user?.role === "admin" && <Switcher onClose={() => {}} />}
      </main>
    </div>
  );
}

function Router() {
  const { organizations, isLoading, currentOrg, chatOnly } = useTenant();
  if (isLoading) return <Spinner />;
  if (organizations.length === 0) return <NoWorkspace />;
  // A guest on shared Projects lists sees those lists and nothing else.
  if ((currentOrg as { guest?: boolean } | null)?.guest)
    return (
      <Switch>
        <Route path="/projects" component={Projects} />
        <Route>{() => <Redirect to="/projects" />}</Route>
      </Switch>
    );
  // Team chat only: the channels and direct messages, the Team page and their account.
  if (chatOnly)
    return (
      <Switch>
        <Route path="/chats" component={ChatPage} />
        <Route path="/chats/team/:channel" component={TeamChatPage} />
        <Route path="/chats/search" component={TeamSearchPage} />
        <Route path="/chats/view/:kind" component={TeamViewPage} />
        <Route path="/team" component={Team} />
        <Route path="/account" component={Account} />
        <Route>{() => <Redirect to="/chats" />}</Route>
      </Switch>
    );
  return (
    <Switch>
      <Route path="/">{() => <Redirect to="/chats" />}</Route>
      <Route path="/chats" component={ChatPage} />
      <Route path="/chats/team/:channel" component={TeamChatPage} />
      <Route path="/chats/search" component={TeamSearchPage} />
      <Route path="/chats/view/:kind" component={TeamViewPage} />
      <Route path="/chats/import-slack" component={SlackImportPage} />
      <Route path="/chats/e/:id/:tab?" component={ChatPage} />
      <Route path="/chats/:kind/app/:appId/:view?" component={ChatPage} />
      <Route path="/chats/:kind/:tab?" component={ChatPage} />
      <Route path="/calendar" component={Calendar} />
      <Route path="/goals" component={Goals} />
      <Route path="/projects" component={Projects} />
      <Route path="/huddle" component={Huddle} />
      <Route path="/activity" component={Activity} />
      <Route path="/approvals" component={Approvals} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/brain" component={Brain} />
      <Route path="/workspace" component={Workspace} />
      <Route path="/integrations" component={Integrations} />
      <Route path="/team" component={Team} />
      <Route path="/account" component={Account} />
      <Route path="/more" component={More} />
      <Route path="/handbook" component={Handbook} />
      <Route path="/handbook/sop/:id" component={SopPage} />
      <Route path="/base" component={BaseInstructions} />
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
      {user.reviewer && <ReviewBar />}
      <Router />
      <Notices />
    </TenantProvider>
  );
}

/** Shown across the top while the Google or Meta app reviewer is signed in. */
function ReviewBar() {
  const { organizations } = useTenant();
  useEffect(() => {
    document.documentElement.classList.add("ld-review");
    return () => document.documentElement.classList.remove("ld-review");
  }, []);
  return (
    <div className="ld-reviewbar" role="status">
      <span>Review account · {organizations[0]?.name ?? "Demo practice"}</span>
      <span className="ld-reviewbar-note">Sample data. No real clients.</span>
    </div>
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
