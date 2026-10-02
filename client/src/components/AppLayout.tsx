import React from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { CreateOrganizationModal } from "@/components/CreateOrganizationModal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Building2,
  ChevronDown,
  Sparkles,
  Bot,
  FileText,
  Mail,
  Share2,
  Globe,
  Database,
  History,
  Settings,
  Plus,
  ShieldCheck,
  CheckCircle2,
  Briefcase,
  Radio,
} from "lucide-react";

export type NavTab =
  | "dashboard"
  | "grant-writer"
  | "assistant"
  | "social"
  | "blog"
  | "publishing"
  | "employees"
  | "knowledge"
  | "audit"
  | "settings";

interface AppLayoutProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ currentTab, onSelectTab, children }) => {
  const { currentOrg, currentOrgId, organizations, switchOrganization, openCreateOrgModal } = useTenant();
  const { data: employees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });
  const { data: queueItems } = trpc.publishing.listApprovalQueue.useQuery({ organizationId: currentOrgId });

  const pendingApprovalsCount = queueItems?.filter((i) => i.status === "pending_approval").length || 0;

  const grantWriter = employees?.find((employee) => employee.roleTitle.toLowerCase().includes("grant"));
  const assistant = employees?.find((employee) => employee.roleTitle.toLowerCase().includes("assistant") || employee.name.toLowerCase().includes("avery"));
  const socialManager = employees?.find((employee) => employee.roleTitle.toLowerCase().includes("social") || employee.name.toLowerCase().includes("sienna"));
  const blogWriter = employees?.find((employee) => employee.roleTitle.toLowerCase().includes("wordpress") || employee.roleTitle.toLowerCase().includes("content") || employee.name.toLowerCase().includes("theo"));

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-40 w-full border-b border-border bg-card/95 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            {/* Left: Brand + Multi-Tenant Switcher */}
            <div className="flex items-center gap-3 sm:gap-6">
              <div
                onClick={() => onSelectTab("dashboard")}
                className="flex items-center gap-2.5 cursor-pointer group select-none"
              >
                <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-black text-lg shadow-sm transition-transform group-hover:scale-105">
                  LE
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-extrabold text-base tracking-tight text-foreground">
                      LeadDash<span className="text-primary font-normal"> Employees</span>
                    </span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-primary/30 text-primary font-medium">
                      Multi-Tenant
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground hidden sm:block">
                    Autonomous Business & Clinical Workforce
                  </p>
                </div>
              </div>

              {/* Organization Switcher Dropdown */}
              <div className="h-6 w-px bg-border hidden sm:block" />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-3 gap-2 border-border/80 bg-background/50 hover:bg-muted text-xs font-medium max-w-[220px] sm:max-w-[280px]"
                  >
                    <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="truncate font-semibold">{currentOrg?.name || "Select Workspace"}</span>
                    {currentOrg?.plan && (
                      <Badge variant="secondary" className="text-[10px] uppercase px-1 py-0 h-4 font-mono shrink-0">
                        {currentOrg.plan}
                      </Badge>
                    )}
                    <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72 bg-popover border-border">
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                    Active Organization Workspaces
                  </DropdownMenuLabel>
                  {organizations.map((org) => {
                    const isActive = org.id === currentOrg?.id;
                    return (
                      <DropdownMenuItem
                        key={org.id}
                        onClick={() => switchOrganization(org.id)}
                        className={`flex items-center justify-between cursor-pointer text-xs py-2 ${
                          isActive ? "bg-primary/10 text-primary font-semibold" : ""
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Building2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{org.name}</span>
                        </div>
                        {isActive && <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={openCreateOrgModal}
                    className="cursor-pointer text-xs text-primary font-medium flex items-center gap-2 py-2"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create New Organization Workspace
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Right: Workforce status pill + Approval Queue Badge */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => onSelectTab("publishing")}
                className="flex items-center gap-1.5 text-xs bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 px-2.5 py-1 rounded-md font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 transition-colors"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
                <span>Approval Queue:</span>
                <span className="font-bold underline">{pendingApprovalsCount} pending</span>
              </button>

              <div className="hidden lg:flex items-center gap-2 text-xs bg-muted/60 border border-border px-3 py-1.5 rounded-full">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-muted-foreground font-medium">
                  Autonomous Workforce: <strong className="text-foreground">Online & Ready</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Sub Navigation Bar Tabs */}
          <nav className="flex space-x-1 border-t border-border/50 py-1 overflow-x-auto scrollbar-none">
            <button
              onClick={() => onSelectTab("dashboard")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "dashboard"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Bot className="h-3.5 w-3.5" />
              Command Center
            </button>

            <button
              onClick={() => onSelectTab("grant-writer")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "grant-writer"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              Grant Writer ({grantWriter?.name.split(" ")[0] || "Morgan"})
            </button>

            <button
              onClick={() => onSelectTab("assistant")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "assistant"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Mail className="h-3.5 w-3.5" />
              Executive Assistant ({assistant?.name.split(" ")[0] || "Avery"})
            </button>

            <button
              onClick={() => onSelectTab("social")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "social"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Share2 className="h-3.5 w-3.5" />
              Social Manager ({socialManager?.name.split(" ")[0] || "Sienna"})
            </button>

            <button
              onClick={() => onSelectTab("blog")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "blog"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              WordPress Writer ({blogWriter?.name.split(" ")[0] || "Theo"})
            </button>

            <button
              onClick={() => onSelectTab("publishing")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "publishing"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Radio className="h-3.5 w-3.5" />
              Integrations & Queue
            </button>

            <button
              onClick={() => onSelectTab("employees")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "employees"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Briefcase className="h-3.5 w-3.5" />
              All Employees
            </button>

            <button
              onClick={() => onSelectTab("knowledge")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "knowledge"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              Knowledge Base
            </button>

            <button
              onClick={() => onSelectTab("audit")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "audit"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <History className="h-3.5 w-3.5" />
              Audit Trail
            </button>

            <button
              onClick={() => onSelectTab("settings")}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                currentTab === "settings"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-card py-6 text-xs text-muted-foreground">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-bold text-foreground">LeadDash Employees</span>
            <span>· Multi-Tenant Autonomous Business & Clinical Workforce</span>
          </div>
          <div className="flex items-center gap-4">
            <span>Workspace: <strong>{currentOrg?.name}</strong></span>
            <span>·</span>
            <span>Zero Unapproved Postings</span>
            <span>·</span>
            <span className="text-primary font-medium">OAuth Scopes Enforced</span>
          </div>
        </div>
      </footer>

      {/* Create Organization Modal */}
      <CreateOrganizationModal />
    </div>
  );
};
