import React from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmployeeAvatar } from "@/components/EmployeeAvatar";
import {
  FileText,
  Bot,
  Sparkles,
  TrendingUp,
  Clock,
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
  Plus,
  Play,
  Pause,
  Layers,
  Search,
  ExternalLink,
  Database,
} from "lucide-react";
import { toast } from "sonner";

interface DashboardViewProps {
  onOpenGrantWriter: () => void;
  onOpenEmployees: () => void;
  onOpenKnowledge: () => void;
  onOpenHireModal: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  onOpenGrantWriter,
  onOpenEmployees,
  onOpenKnowledge,
  onOpenHireModal,
}) => {
  const { currentOrgId, currentOrg } = useTenant();

  const { data: employees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });
  const { data: opportunities } = trpc.grants.listOpportunities.useQuery({ organizationId: currentOrgId });
  const { data: auditLogs } = trpc.audit.list.useQuery({ organizationId: currentOrgId, limit: 6 });

  const scoutMutation = trpc.grants.scoutOpportunities.useMutation({
    onSuccess: () => {
      toast.success("Morgan Hayes completed an autonomous RFP scout and identified new matches!");
    },
  });

  const activeOpportunitiesCount = opportunities?.length || 0;
  const activeEmployeesCount = employees?.filter((e) => e.status === "active" || e.status === "working").length || 0;
  const totalHoursSaved = employees?.reduce((acc, e) => acc + (e.hoursSaved || 0), 0) || 0;
  const totalFundingValue = opportunities?.reduce((total, opportunity) => {
    const firstAmount = opportunity.fundingAmount?.match(/\$([\d,]+)/)?.[1];
    return total + (firstAmount ? Number(firstAmount.replace(/,/g, "")) : 0);
  }, 0) || 0;
  const totalFundingIdentified = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(totalFundingValue);
  const inReviewOpportunities = opportunities?.filter((opportunity) =>
    ["under_review", "drafting", "qualified"].includes(opportunity.status)
  ) || [];
  const priorityOpportunity = inReviewOpportunities[0] || opportunities?.[0] || null;
  const grantWriter = employees?.find((employee) => employee.roleTitle.toLowerCase().includes("grant"));

  return (
    <div className="space-y-8">
      {/* Hero / Strategic Outcome Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-emerald-950 via-[#0d3b2c] to-[#0f241c] text-white p-6 sm:p-8 shadow-md border border-emerald-800/40">
        <div className="relative z-10 max-w-3xl space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/20 border border-emerald-400/30 px-3 py-1 text-xs text-emerald-200">
            <Sparkles className="h-3.5 w-3.5 text-emerald-300" />
            <span>Autonomous AI Workforce for {currentOrg?.name}</span>
          </div>

          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-white">
            Scale Operations & Expand Funding With Dedicated AI Employees
          </h1>

          <p className="text-sm sm:text-base text-emerald-100/80 leading-relaxed">
            Your specialized AI employees handle grant discovery, proposal drafting, intake coordination, and compliance tracking behind the scenes. Every proposal stays grounded in verified organizational facts and requires human approval before external submission.
          </p>

          <div className="pt-2 flex flex-wrap gap-3">
            <Button
              onClick={onOpenGrantWriter}
              className="gap-2 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold shadow-sm"
            >
              <FileText className="h-4 w-4" />
              Open Grant Writer Studio
            </Button>
            <Button
              variant="outline"
              onClick={() => scoutMutation.mutate({ organizationId: currentOrgId })}
              disabled={scoutMutation.isPending}
              className="gap-2 border-emerald-400/40 text-emerald-100 hover:bg-emerald-800/50 hover:text-white"
            >
              <Search className="h-4 w-4" />
              {scoutMutation.isPending ? "Scouting Portals..." : `Scout New Grants with ${grantWriter?.name || "Grant Writer"}`}
            </Button>
          </div>
        </div>

        {/* Decorative subtle background shape */}
        <div className="absolute -right-12 -bottom-12 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-border/80 shadow-xs hover:border-primary/40 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Grant Pipeline Identified
            </CardDescription>
            <CardTitle className="text-2xl font-black text-foreground">{totalFundingIdentified}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-primary" />
            <span>Across <strong>{activeOpportunitiesCount}</strong> qualified opportunities</span>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-xs hover:border-primary/40 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Proposals in Progress
            </CardDescription>
            <CardTitle className="text-2xl font-black text-foreground">
              {inReviewOpportunities.length} High Priority
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200">
              {priorityOpportunity?.status === "under_review" ? "Needs Review" : "Qualified"}
            </Badge>
            <span className="truncate">{priorityOpportunity?.title || "No grants scoped yet"}</span>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-xs hover:border-primary/40 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Active AI Employees
            </CardDescription>
            <CardTitle className="text-2xl font-black text-foreground">{activeEmployeesCount} On Duty</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 text-primary" />
            <span>{activeEmployeesCount ? "Tenant-scoped employees online" : "No active employees"}</span>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-xs hover:border-primary/40 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Operations Hours Saved
            </CardDescription>
            <CardTitle className="text-2xl font-black text-foreground">{totalHoursSaved} Hours</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-emerald-600" />
            <span>Accumulated work capacity saved</span>
          </CardContent>
        </Card>
      </div>

      {/* AI Employees Roster Section (Marblism Employee Cards) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-foreground">
              Your AI Operations Team
            </h2>
            <p className="text-xs text-muted-foreground">
              Role-based autonomous agents configured specifically for {currentOrg?.name}.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onOpenEmployees} className="text-xs gap-1.5">
              <span>View Roster</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" onClick={onOpenHireModal} className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="h-3.5 w-3.5" />
              Onboard Employee
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {employees?.map((employee) => {
            const isGrantWriter = employee.roleTitle.toLowerCase().includes("grant");
            const isOnline = employee.status === "active" || employee.status === "working";
            return (
              <Card key={employee.id} className={`bg-card shadow-xs transition-all flex flex-col justify-between ${isGrantWriter ? "border-2 border-primary/30 hover:shadow-md" : "border border-border/80 hover:border-primary/30"}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <EmployeeAvatar name={employee.name} avatar={employee.avatar} status={employee.status} showStatus className="h-12 w-12" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <CardTitle className="text-base font-bold truncate">{employee.name}</CardTitle>
                        <Badge className={`text-[10px] px-1.5 py-0 h-4 ${isOnline ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"}`}>{employee.status}</Badge>
                      </div>
                      <p className="text-xs font-medium text-primary truncate">{employee.roleTitle}</p>
                      <p className="text-[11px] text-muted-foreground">{employee.department}</p>
                    </div>
                  </div>
                  <CardDescription className="text-xs mt-3 leading-relaxed line-clamp-3">{employee.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-3">
                  <div className="rounded-lg bg-muted/60 p-2.5 text-xs space-y-1.5">
                    <div className="flex justify-between text-muted-foreground"><span>Quality Rate:</span><span className="font-semibold text-emerald-600">{employee.efficiency}%</span></div>
                    <div className="flex justify-between text-muted-foreground"><span>Tasks Completed:</span><span className="font-semibold text-foreground">{employee.tasksCompleted}</span></div>
                    <div className="flex justify-between text-muted-foreground"><span>Work Saved:</span><span className="font-semibold text-foreground">{employee.hoursSaved} Hours</span></div>
                  </div>
                </CardContent>
                <CardFooter className="pt-0">
                  <Button variant={isGrantWriter ? "default" : "outline"} onClick={isGrantWriter ? onOpenGrantWriter : onOpenEmployees} className={`w-full gap-2 text-xs ${isGrantWriter ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}>
                    {isGrantWriter ? <FileText className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                    {isGrantWriter ? "Launch Grant Workspace" : "View Responsibilities"}
                    <ArrowRight className="h-3.5 w-3.5 ml-auto" />
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Autonomous Activity Feed & Human Verification Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-foreground">
              Live Workforce Activity Stream
            </h3>
            <span className="text-xs text-muted-foreground">Audit logged in real time</span>
          </div>

          <Card className="border-border/80">
            <div className="divide-y divide-border/60">
              {auditLogs?.map((log) => (
                <div key={log.id} className="p-4 flex items-start gap-3.5 text-xs">
                  <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                    {log.actorType === "employee" ? <Bot className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-foreground">{log.actorName}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(log.createdAt).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="font-medium text-primary text-xs">{log.action}</p>
                    <p className="text-muted-foreground leading-relaxed">{log.details}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Human-in-the-Loop Safeguard Guarantee Card */}
        <div className="space-y-4">
          <h3 className="text-base font-bold text-foreground">
            Safety & Governance Guardrail
          </h3>

          <Card className="border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                <ShieldCheck className="h-5 w-5" />
                <CardTitle className="text-sm font-bold">Zero Autonomous Submissions</CardTitle>
              </div>
              <CardDescription className="text-xs text-emerald-900/80 dark:text-emerald-200/80 leading-relaxed pt-1">
                LeadDash Employees guarantees that no RFP, grant application, contract bid, or legal attestation can be submitted to external portals without a human reviewer approving the exact package.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span>Isolated tenant data & database encryption</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span>Grounding context checked against verified records</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span>Explicit Authorized Representative sign-off queue</span>
              </div>
            </CardContent>
            <CardFooter className="pt-2">
              <Button variant="outline" size="sm" onClick={onOpenKnowledge} className="w-full text-xs gap-1.5 border-emerald-300 dark:border-emerald-800">
                <Database className="h-3.5 w-3.5" />
                Manage Grounding Knowledge
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
};
