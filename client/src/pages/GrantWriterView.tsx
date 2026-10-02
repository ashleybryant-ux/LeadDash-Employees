import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmployeeAvatar } from "@/components/EmployeeAvatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  FileText,
  Sparkles,
  Search,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Download,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Send,
  Building2,
  Check,
  Edit3,
  Copy,
  Printer,
} from "lucide-react";
import { toast } from "sonner";

export const GrantWriterView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();

  const [activeTab, setActiveTab] = useState<"radar" | "studio" | "approval">("radar");
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<number | null>(null);
  const [selectedSection, setSelectedSection] = useState<
    "executiveSummary" | "statementOfNeed" | "programDesign" | "budgetNarrative" | "evaluationPlan"
  >("executiveSummary");

  const [guidancePrompt, setGuidancePrompt] = useState("");
  const [isRequirementModalOpen, setIsRequirementModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [reviewerName, setReviewerName] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");

  // Data fetching
  const { data: opportunities, refetch: refetchOpps } = trpc.grants.listOpportunities.useQuery({
    organizationId: currentOrgId,
  });
  const { data: employees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });
  const { data: knowledgeItems } = trpc.knowledge.list.useQuery({ organizationId: currentOrgId });

  const { data: proposal, refetch: refetchProposal } = trpc.grants.getProposal.useQuery({
    organizationId: currentOrgId,
    opportunityId: selectedOpportunityId || undefined,
  });

  const [localSectionContent, setLocalSectionContent] = useState<string>("");

  // Each organization has an isolated opportunity and proposal pipeline. Reset the
  // current selection before reading data for a newly selected workspace.
  React.useEffect(() => {
    setSelectedOpportunityId(null);
    setLocalSectionContent("");
  }, [currentOrgId]);

  React.useEffect(() => {
    if (!selectedOpportunityId && opportunities?.[0]) {
      setSelectedOpportunityId(opportunities[0].id);
    }
  }, [opportunities, selectedOpportunityId]);

  // Update local content when proposal data loads or section changes
  React.useEffect(() => {
    if (proposal && (proposal as any)[selectedSection]) {
      setLocalSectionContent((proposal as any)[selectedSection] || "");
    }
  }, [proposal, selectedSection]);

  // Mutations
  const scoutMutation = trpc.grants.scoutOpportunities.useMutation({
    onSuccess: () => {
      toast.success("Morgan Hayes scanned federal and state feeds and discovered new opportunities!");
      refetchOpps();
    },
    onError: (err) => {
      toast.error("Scout failed: " + err.message);
    },
  });

  const generateMutation = trpc.grants.generateSection.useMutation({
    onSuccess: (data) => {
      toast.success("Morgan Hayes generated an evidence-grounded draft section!");
      setLocalSectionContent(data.content);
      refetchProposal();
    },
    onError: (err) => {
      toast.error("Drafting failed: " + err.message);
    },
  });

  const updateProposalMutation = trpc.grants.updateProposal.useMutation({
    onSuccess: () => {
      toast.success("Proposal changes saved!");
      refetchProposal();
    },
    onError: (err) => {
      toast.error("Save failed: " + err.message);
    },
  });

  const reviewMutation = trpc.grants.reviewProposal.useMutation({
    onSuccess: (updated) => {
      toast.success(`Proposal marked as: ${updated?.status?.toUpperCase()}!`);
      refetchProposal();
      setIsExportModalOpen(false);
    },
    onError: (err) => {
      toast.error("Review action failed: " + err.message);
    },
  });

  const selectedOpp = opportunities?.find((o) => o.id === selectedOpportunityId) || null;
  const grantWriter = employees?.find((employee) => employee.roleTitle.toLowerCase().includes("grant"));
  const strategistName = grantWriter?.name || "Grant Writer";
  const pipelineFunding = opportunities?.reduce((total, opportunity) => {
    const firstAmount = opportunity.fundingAmount?.match(/\$([\d,]+)/)?.[1];
    return total + (firstAmount ? Number(firstAmount.replace(/,/g, "")) : 0);
  }, 0) || 0;
  const pipelineFundingLabel = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(pipelineFunding);

  const handleSaveSection = () => {
    if (!proposal) return;
    const updatePayload: Record<string, any> = {
      id: proposal.id,
      organizationId: currentOrgId,
    };
    updatePayload[selectedSection] = localSectionContent;
    updateProposalMutation.mutate(updatePayload as any);
  };

  const handleGenerateSection = () => {
    if (!proposal) return;
    generateMutation.mutate({
      organizationId: currentOrgId,
      proposalId: proposal.id,
      sectionKey: selectedSection,
      guidancePrompt: guidancePrompt.trim() || undefined,
    });
  };

  // Section names mapping
  const sectionLabels: Record<string, string> = {
    executiveSummary: "Executive Summary & Abstract",
    statementOfNeed: "Statement of Need & Demographics",
    programDesign: "Program Design & Logic Model",
    budgetNarrative: "Budget Narrative & Line-Item Justification",
    evaluationPlan: "Evaluation Plan & GPRA Milestones",
  };

  // Parse compliance checklist
  let checklist: Array<{ item: string; verified: boolean }> = [];
  try {
    if (proposal?.complianceChecklist) {
      checklist = JSON.parse(proposal.complianceChecklist);
    }
  } catch (e) {
    checklist = [];
  }

  // Parse deliverables
  let deliverablesList: string[] = [];
  try {
    if (selectedOpp?.deliverables) {
      deliverablesList = JSON.parse(selectedOpp.deliverables);
    }
  } catch (e) {
    deliverablesList = [];
  }

  return (
    <div className="space-y-6">
      {/* Employee Bio & Status Header */}
      <div className="rounded-2xl border border-primary/20 bg-card p-6 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <EmployeeAvatar name={strategistName} avatar={grantWriter?.avatar} status={grantWriter?.status} showStatus className="h-16 w-16" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-black text-foreground">{strategistName}</h1>
              <Badge className="bg-emerald-600 text-white text-xs px-2 py-0.5">Active & Scouting</Badge>
              <Badge variant="outline" className="border-border text-muted-foreground text-xs">
                AI Employee ID: LE-GW-{grantWriter?.id || "01"}
              </Badge>
            </div>
            <p className="text-sm font-semibold text-primary">{grantWriter?.roleTitle || "Senior Grant & RFP Strategist"} · {grantWriter?.department || "Development & Funding"}</p>
            <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
              Autonomously monitors federal portals, state departments of health, and philanthropic foundations. Qualifies scoring criteria against {currentOrg?.name}’s clinical focus, drafts full proposal sections, and packages them for executive approval.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap md:flex-nowrap gap-4 shrink-0 bg-muted/50 p-3.5 rounded-xl border border-border">
          <div className="text-center px-3">
            <div className="text-xs text-muted-foreground">Scoring Alignment</div>
            <div className="text-lg font-black text-emerald-600">{grantWriter?.efficiency || 0}%</div>
          </div>
          <div className="h-10 w-px bg-border my-auto" />
          <div className="text-center px-3">
            <div className="text-xs text-muted-foreground">Hours Saved</div>
            <div className="text-lg font-black text-foreground">{grantWriter?.hoursSaved || 0} hrs</div>
          </div>
          <div className="h-10 w-px bg-border my-auto" />
          <div className="text-center px-3">
            <div className="text-xs text-muted-foreground">Active Pipeline</div>
            <div className="text-lg font-black text-primary">{pipelineFundingLabel}</div>
          </div>
        </div>
      </div>

      {/* Main Tabs Navigation */}
      <Tabs value={activeTab} onValueChange={(val: any) => setActiveTab(val)} className="space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-border pb-3">
          <TabsList className="bg-muted p-1">
            <TabsTrigger value="radar" className="text-xs sm:text-sm gap-2">
              <Search className="h-4 w-4" />
              1. RFP Radar & Opportunities
            </TabsTrigger>
            <TabsTrigger value="studio" className="text-xs sm:text-sm gap-2">
              <Edit3 className="h-4 w-4" />
              2. Proposal Studio & AI Drafter
            </TabsTrigger>
            <TabsTrigger value="approval" className="text-xs sm:text-sm gap-2">
              <ShieldCheck className="h-4 w-4" />
              3. Compliance & Human Approval
              {proposal?.status === "pending_review" && (
                <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              )}
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => scoutMutation.mutate({ organizationId: currentOrgId })}
              disabled={scoutMutation.isPending}
              className="text-xs gap-1.5 border-border"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scoutMutation.isPending ? "animate-spin" : ""}`} />
              {scoutMutation.isPending ? "Scouting Portals..." : `Scout with ${strategistName}`}
            </Button>
            <Button
              size="sm"
              onClick={() => setIsExportModalOpen(true)}
              className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Download className="h-3.5 w-3.5" />
              Export Package
            </Button>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* TAB 1: RFP & GRANT RADAR */}
        {/* ========================================================================= */}
        <TabsContent value="radar" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-foreground">Discovered Funding Opportunities</h2>
              <p className="text-xs text-muted-foreground">
                Matched against {currentOrg?.name}’s verified mission, geographic service area, and clinical capabilities.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              Showing <strong>{opportunities?.length || 0}</strong> qualified opportunities
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {opportunities?.map((opp) => {
              const isSelected = opp.id === selectedOpportunityId;
              return (
                <Card
                  key={opp.id}
                  className={`border transition-all ${
                    isSelected ? "border-primary shadow-sm bg-card" : "border-border/80 hover:border-primary/40 bg-card"
                  }`}
                >
                  <CardContent className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                    <div className="space-y-2 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          className={`text-xs font-bold ${
                            opp.matchScore >= 95
                              ? "bg-emerald-600 text-white"
                              : opp.matchScore >= 90
                              ? "bg-emerald-500/90 text-white"
                              : "bg-amber-600 text-white"
                          }`}
                        >
                          {opp.matchScore}% Match Score
                        </Badge>
                        <Badge variant="outline" className="text-xs border-border">
                          {opp.source}
                        </Badge>
                        <span className="text-xs text-muted-foreground font-mono">
                          Due: <strong>{opp.deadline || "TBD"}</strong>
                        </span>
                        {opp.status === "under_review" && (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200 text-xs">
                            Draft In Review
                          </Badge>
                        )}
                      </div>

                      <h3 className="text-base font-bold text-foreground hover:text-primary transition-colors cursor-pointer"
                        onClick={() => {
                          setSelectedOpportunityId(opp.id);
                          setActiveTab("studio");
                        }}
                      >
                        {opp.title}
                      </h3>

                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                        {opp.summary}
                      </p>

                      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground pt-1">
                        <span>Funder: <strong className="text-foreground">{opp.funder}</strong></span>
                        <span>·</span>
                        <span>Award Ceiling: <strong className="text-primary font-bold">{opp.fundingAmount}</strong></span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 border-t lg:border-t-0 pt-3 lg:pt-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedOpportunityId(opp.id);
                          setIsRequirementModalOpen(true);
                        }}
                        className="text-xs gap-1.5"
                      >
                        View Criteria
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelectedOpportunityId(opp.id);
                          setActiveTab("studio");
                        }}
                        className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        <span>Open Proposal Studio</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        {/* ========================================================================= */}
        {/* TAB 2: PROPOSAL STUDIO & AI DRAFTER */}
        {/* ========================================================================= */}
        <TabsContent value="studio" className="space-y-6">
          {/* Header context card */}
          <div className="rounded-xl bg-muted/60 border border-border p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase">Target Opportunity:</span>
                <span className="text-xs font-bold text-primary">{selectedOpp?.funder}</span>
              </div>
              <h3 className="text-base font-bold text-foreground">{proposal?.title || selectedOpp?.title}</h3>
              <p className="text-xs text-muted-foreground">
                Funding Request: <strong>{selectedOpp?.fundingAmount}</strong> · Deadline: <strong>{selectedOpp?.deadline}</strong>
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActiveTab("approval")}
                className="text-xs gap-1.5 border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Go to Human Approval Gate
              </Button>
            </div>
          </div>

          {/* Section Selector Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {(
              [
                "executiveSummary",
                "statementOfNeed",
                "programDesign",
                "budgetNarrative",
                "evaluationPlan",
              ] as const
            ).map((key) => {
              const isSelected = selectedSection === key;
              const hasContent = Boolean(proposal && (proposal as any)[key]);
              return (
                <button
                  key={key}
                  onClick={() => setSelectedSection(key)}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    isSelected
                      ? "border-primary bg-primary/10 shadow-xs"
                      : "border-border/80 bg-card hover:border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="font-semibold text-muted-foreground uppercase">Section</span>
                    {hasContent ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    )}
                  </div>
                  <div className={`text-xs font-bold line-clamp-1 ${isSelected ? "text-primary" : "text-foreground"}`}>
                    {sectionLabels[key]}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Active Section Editor & AI Generator */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left 2 cols: Text Editor */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-foreground">{sectionLabels[selectedSection]}</h3>
                  <p className="text-xs text-muted-foreground">
                    Edit content directly or instruct {strategistName} to synthesize/refine this section.
                  </p>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {localSectionContent.length} chars
                </div>
              </div>

              <Textarea
                rows={16}
                value={localSectionContent}
                onChange={(e) => setLocalSectionContent(e.target.value)}
                placeholder="Section content is currently empty. Use the Morgan Hayes drafter on the right or type directly..."
                className="font-serif text-sm leading-relaxed p-4 bg-card border-border focus-visible:ring-primary shadow-xs"
              />

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">
                  Changes persist to database on save.
                </span>
                <Button
                  onClick={handleSaveSection}
                  disabled={updateProposalMutation.isPending}
                  size="sm"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs gap-1.5"
                >
                  <Check className="h-3.5 w-3.5" />
                  {updateProposalMutation.isPending ? "Saving..." : "Save Section"}
                </Button>
              </div>
            </div>

            {/* Right col: Morgan Hayes AI Drafting Studio */}
            <div className="space-y-4">
              <Card className="border-primary/30 bg-primary/5 shadow-xs">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2 text-primary">
                    <Sparkles className="h-4 w-4" />
                    <CardTitle className="text-sm font-bold">AI Drafting Co-Pilot</CardTitle>
                  </div>
                  <CardDescription className="text-xs leading-relaxed text-muted-foreground pt-1">
                    {strategistName} synthesizes verified facts from <strong>{currentOrg?.name}</strong>’s grounding knowledge base and aligns the narrative with federal scoring rubrics.
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-3 pb-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="guidance-input" className="text-xs font-semibold">
                      Custom Clinical / Strategic Guidance (Optional)
                    </Label>
                    <Textarea
                      id="guidance-input"
                      rows={3}
                      placeholder="e.g. Emphasize our 48-hour crisis intake turnaround, bilingual peer support staff, and CARF accreditation..."
                      value={guidancePrompt}
                      onChange={(e) => setGuidancePrompt(e.target.value)}
                      className="text-xs bg-card"
                    />
                  </div>

                  <div className="rounded-lg bg-card p-3 border border-border/80 text-[11px] text-muted-foreground space-y-1">
                    <div className="font-semibold text-foreground">Grounding Sources Checked:</div>
                    {knowledgeItems?.length ? knowledgeItems.slice(0, 3).map((item) => (
                      <div key={item.id}>✓ {item.title}</div>
                    )) : (
                      <div>✓ No knowledge records yet — add verified organizational facts before drafting.</div>
                    )}
                  </div>
                </CardContent>

                <CardFooter className="pt-0">
                  <Button
                    onClick={handleGenerateSection}
                    disabled={generateMutation.isPending}
                    className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-bold"
                  >
                    <Sparkles className={`h-3.5 w-3.5 ${generateMutation.isPending ? "animate-spin" : ""}`} />
                    {generateMutation.isPending ? `${strategistName} is Drafting...` : `Draft "${sectionLabels[selectedSection]}"`}
                  </Button>
                </CardFooter>
              </Card>

              {/* Rubric Checklist Box */}
              <Card className="border-border/80 bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Scoring Rubric Alignment
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs space-y-2 text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    <span>Evidence-based clinical modalities cited</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    <span>Quantified participant milestones (min 450)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    <span>Federal de minimis indirect rate calculated</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ========================================================================= */}
        {/* TAB 3: COMPLIANCE & HUMAN APPROVAL GATE */}
        {/* ========================================================================= */}
        <TabsContent value="approval" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left 2 cols: Compliance & Approval Workspace */}
            <div className="lg:col-span-2 space-y-6">
              {/* Proposal Status Banner */}
              <div
                className={`rounded-xl border p-5 flex items-start gap-4 ${
                  proposal?.status === "approved" || proposal?.status === "ready_for_portal"
                    ? "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800"
                    : "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"
                }`}
              >
                <ShieldCheck
                  className={`h-6 w-6 shrink-0 mt-0.5 ${
                    proposal?.status === "approved" || proposal?.status === "ready_for_portal"
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-amber-700 dark:text-amber-300"
                  }`}
                />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-foreground text-sm">
                      {proposal?.status === "approved" || proposal?.status === "ready_for_portal"
                        ? "Proposal Certified by Authorized Human Representative"
                        : "Awaiting Human Review & Authorized Sign-Off"}
                    </h3>
                    <Badge
                      className={
                        proposal?.status === "approved" || proposal?.status === "ready_for_portal"
                          ? "bg-emerald-700 text-white text-xs"
                          : "bg-amber-600 text-white text-xs"
                      }
                    >
                      {proposal?.status?.toUpperCase()}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {proposal?.status === "approved"
                      ? `Approved by ${proposal.approvedBy || "Authorized Official"} on ${new Date(
                          proposal.approvedAt || Date.now()
                        ).toLocaleDateString()}. Package is cleared for human entry into the funder portal.`
                      : "LeadDash Employees policy mandates that no proposal or application can be transmitted to Grants.gov, SAM.gov, or state portal without an explicit human review."}
                  </p>
                </div>
              </div>

              {/* Compliance Checklist */}
              <Card className="border-border/80">
                <CardHeader>
                  <CardTitle className="text-base font-bold">Mandatory Pre-Submission Compliance Checklist</CardTitle>
                  <CardDescription className="text-xs">
                    Verified automatically by {strategistName} against the official Notice of Funding Opportunity (NOFO).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {checklist.map((item, idx) => (
                    <div key={idx} className="flex items-start gap-3 p-2.5 rounded-lg bg-muted/40 text-xs">
                      {item.verified ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1">
                        <span className={item.verified ? "text-foreground font-medium" : "text-amber-800 dark:text-amber-300 font-semibold"}>
                          {item.item}
                        </span>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {item.verified ? "Verified" : "Action Required"}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Reviewer Action Station */}
              <Card className="border-border/80">
                <CardHeader>
                  <CardTitle className="text-base font-bold">Authorized Organization Representative Sign-Off</CardTitle>
                  <CardDescription className="text-xs">
                    Record your name, role, and decision to approve or return this proposal draft.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="reviewer-name" className="text-xs">
                      Authorized Reviewer Name & Title
                    </Label>
                    <Input
                      id="reviewer-name"
                      value={reviewerName}
                      onChange={(e) => setReviewerName(e.target.value)}
                      placeholder="e.g. Sarah Chen, LCSW (Clinical Director)"
                      className="text-xs"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="review-notes" className="text-xs">
                      Reviewer Attestation / Change Request Notes
                    </Label>
                    <Textarea
                      id="review-notes"
                      rows={3}
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      placeholder="e.g. All budget lines verified against 2026 salary schedule. Ready for submission packet assembly..."
                      className="text-xs"
                    />
                  </div>

                  <div className="flex flex-wrap gap-3 pt-2">
                    <Button
                      onClick={() =>
                        reviewMutation.mutate({
                          organizationId: currentOrgId,
                          proposalId: proposal?.id || 1,
                          action: "approve",
                          notes: reviewNotes.trim() || undefined,
                          reviewerName: reviewerName.trim() || undefined,
                        })
                      }
                      disabled={reviewMutation.isPending}
                      className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs gap-1.5"
                    >
                      <Check className="h-4 w-4" />
                      {reviewMutation.isPending ? "Processing..." : "Approve Proposal & Certify"}
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() =>
                        reviewMutation.mutate({
                          organizationId: currentOrgId,
                          proposalId: proposal?.id || 1,
                          action: "request_edits",
                          notes: reviewNotes.trim() || "Please revise staffing FTE breakdown.",
                          reviewerName: reviewerName.trim() || undefined,
                        })
                      }
                      disabled={reviewMutation.isPending}
                      className="text-xs gap-1.5 border-amber-400 text-amber-800 dark:text-amber-300"
                    >
                      Request Revisions
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() => setIsExportModalOpen(true)}
                      className="text-xs gap-1.5 ml-auto"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download Clean Copy
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Right col: Safeguard Info & Package Metadata */}
            <div className="space-y-4">
              <Card className="border-border/80 bg-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-bold">Proposal Package Summary</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-xs">
                  <div className="flex justify-between py-1 border-b border-border/60">
                    <span className="text-muted-foreground">Version:</span>
                    <span className="font-mono font-bold text-foreground">{proposal?.version || "v1.2"}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/60">
                    <span className="text-muted-foreground">Assigned Strategist:</span>
                    <span className="font-semibold text-foreground">{strategistName}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/60">
                    <span className="text-muted-foreground">Target Funder:</span>
                    <span className="font-semibold text-foreground truncate max-w-[160px]">{selectedOpp?.funder}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/60">
                    <span className="text-muted-foreground">Total Budget:</span>
                    <span className="font-bold text-primary">{selectedOpp?.fundingAmount}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-muted-foreground">Last Updated:</span>
                    <span className="text-foreground">
                      {proposal?.updatedAt ? new Date(proposal.updatedAt).toLocaleDateString() : "Today"}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Portal Entry Instructions */}
              <Card className="border-border/80 bg-muted/40">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Next Step: Portal Submission
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground space-y-2 leading-relaxed">
                  <p>
                    Once certified above, download the clean proposal package and paste or upload each section into the designated portal (e.g. <strong>Grants.gov Workspace</strong> or state procurement portal).
                  </p>
                  <p className="font-semibold text-foreground">
                    Never give AI agents external signing or banking credentials.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Opportunity Requirements Modal */}
      <Dialog open={isRequirementModalOpen} onOpenChange={setIsRequirementModalOpen}>
        <DialogContent className="max-w-2xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">{selectedOpp?.title}</DialogTitle>
            <DialogDescription className="text-xs">
              Funder: {selectedOpp?.funder} · Source: {selectedOpp?.source}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            <div>
              <h4 className="font-bold text-foreground mb-1">Opportunity Summary</h4>
              <p className="text-muted-foreground leading-relaxed">{selectedOpp?.summary}</p>
            </div>

            <div>
              <h4 className="font-bold text-foreground mb-1">Eligibility Criteria</h4>
              <p className="text-muted-foreground leading-relaxed">{selectedOpp?.eligibility}</p>
            </div>

            <div>
              <h4 className="font-bold text-foreground mb-1">Mandatory Deliverables & Outcomes</h4>
              <ul className="space-y-1.5 pl-4 list-disc text-muted-foreground">
                {deliverablesList.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRequirementModalOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setIsRequirementModalOpen(false);
                setActiveTab("studio");
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5 text-xs"
            >
              <span>Draft With Morgan Hayes</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export Clean Package Modal */}
      <Dialog open={isExportModalOpen} onOpenChange={setIsExportModalOpen}>
        <DialogContent className="max-w-2xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">Export Proposal Package</DialogTitle>
            <DialogDescription className="text-xs">
              Clean, submission-ready grant text for {proposal?.title}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground">
              Ready for copying into Grants.gov Workspace, Assist, or state procurement portal text boxes.
            </div>

            <Textarea
              rows={12}
              readOnly
              value={`# ${proposal?.title || "Grant Proposal"}
Organization: ${currentOrg?.name}
Funder: ${selectedOpp?.funder}
Target Funding: ${selectedOpp?.fundingAmount}
Certification: Approved by ${proposal?.approvedBy || "Authorized Official"} (${proposal?.status})

==================================================
1. EXECUTIVE SUMMARY & ABSTRACT
==================================================
${proposal?.executiveSummary || "[Section Draft Pending]"}

==================================================
2. STATEMENT OF NEED & POPULATION DEMOGRAPHICS
==================================================
${proposal?.statementOfNeed || "[Section Draft Pending]"}

==================================================
3. PROGRAM DESIGN & LOGIC MODEL
==================================================
${proposal?.programDesign || "[Section Draft Pending]"}

==================================================
4. BUDGET NARRATIVE & JUSTIFICATION
==================================================
${proposal?.budgetNarrative || "[Section Draft Pending]"}

==================================================
5. EVALUATION PLAN & MEASURABLE OUTCOMES
==================================================
${proposal?.evaluationPlan || "[Section Draft Pending]"}
`}
              className="font-mono text-xs leading-relaxed"
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(
                  `# ${proposal?.title}\n\n${proposal?.executiveSummary}\n\n${proposal?.statementOfNeed}\n\n${proposal?.programDesign}\n\n${proposal?.budgetNarrative}\n\n${proposal?.evaluationPlan}`
                );
                toast.success("Complete proposal copied to clipboard!");
              }}
              className="text-xs gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy All Text
            </Button>
            <Button
              onClick={() => {
                const element = document.createElement("a");
                const file = new Blob(
                  [
                    `# ${proposal?.title}\n\n` +
                      `## 1. Executive Summary\n${proposal?.executiveSummary}\n\n` +
                      `## 2. Statement of Need\n${proposal?.statementOfNeed}\n\n` +
                      `## 3. Program Design\n${proposal?.programDesign}\n\n` +
                      `## 4. Budget Narrative\n${proposal?.budgetNarrative}\n\n` +
                      `## 5. Evaluation Plan\n${proposal?.evaluationPlan}`
                  ],
                  { type: "text/markdown" }
                );
                element.href = URL.createObjectURL(file);
                element.download = `${currentOrg?.slug}-grant-proposal-${selectedOpp?.id || "draft"}.md`;
                document.body.appendChild(element);
                element.click();
                document.body.removeChild(element);
                toast.success("Downloaded proposal markdown file!");
              }}
              className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Download className="h-3.5 w-3.5" />
              Download Markdown (.md)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
