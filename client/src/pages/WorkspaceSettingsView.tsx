import React, { useState, useEffect } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Building2,
  CheckCircle2,
  ShieldCheck,
  CreditCard,
  Users,
  Plus,
  Sparkles,
  Layers,
  Lock,
} from "lucide-react";
import { toast } from "sonner";

export const WorkspaceSettingsView: React.FC = () => {
  const { currentOrgId, currentOrg, refetchOrgs, openCreateOrgModal } = useTenant();

  const [name, setName] = useState("");
  const [focusAreas, setFocusAreas] = useState("");
  const [annualBudget, setAnnualBudget] = useState("");
  const [ein, setEin] = useState("");
  const [state, setState] = useState("");

  useEffect(() => {
    if (currentOrg) {
      setName(currentOrg.name || "");
      setFocusAreas(currentOrg.focusAreas || "");
      setAnnualBudget(currentOrg.annualBudget || "");
      setEin(currentOrg.ein || "");
      setState(currentOrg.state || "");
    }
  }, [currentOrg]);

  const updateMutation = trpc.organizations.update.useMutation({
    onSuccess: () => {
      toast.success("Workspace parameters updated successfully!");
      refetchOrgs();
    },
    onError: (err) => {
      toast.error("Failed to update workspace: " + err.message);
    },
  });

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate({
      id: currentOrgId,
      name,
      focusAreas,
      annualBudget,
      ein,
      state,
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
          Workspace Settings & Multi-Tenancy
        </h1>
        <p className="text-xs text-muted-foreground">
          Configure mission profile and operational boundaries for <strong>{currentOrg?.name}</strong>.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 cols: Org Profile Form */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border/80">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-bold">Organization Profile</CardTitle>
                <Badge variant="outline" className="text-xs uppercase font-mono">
                  Slug: {currentOrg?.slug}
                </Badge>
              </div>
              <CardDescription className="text-xs">
                These parameters guide the AI Grant Writer and other employees when calculating eligibility and scoring fit.
              </CardDescription>
            </CardHeader>

            <form onSubmit={handleSave}>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ws-name" className="text-xs">Organization Legal Name</Label>
                    <Input
                      id="ws-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-ein" className="text-xs">Federal Tax ID / EIN</Label>
                    <Input
                      id="ws-ein"
                      value={ein}
                      onChange={(e) => setEin(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ws-budget" className="text-xs">Annual Operating Budget</Label>
                    <Input
                      id="ws-budget"
                      value={annualBudget}
                      onChange={(e) => setAnnualBudget(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ws-state" className="text-xs">Primary State / Jurisdiction</Label>
                    <Input
                      id="ws-state"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ws-focus" className="text-xs">Core Focus Areas & Specializations</Label>
                  <Textarea
                    id="ws-focus"
                    rows={3}
                    value={focusAreas}
                    onChange={(e) => setFocusAreas(e.target.value)}
                    className="text-xs leading-relaxed"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Opportunities matching these keywords receive higher priority scoring in the Grant Writer radar.
                  </p>
                </div>
              </CardContent>

              <CardFooter className="border-t border-border/60 flex items-center justify-between pt-4">
                <span className="text-xs text-muted-foreground">
                  Last updated: {currentOrg?.updatedAt ? new Date(currentOrg.updatedAt).toLocaleDateString() : "Today"}
                </span>
                <Button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs gap-1.5"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {updateMutation.isPending ? "Saving..." : "Save Workspace Changes"}
                </Button>
              </CardFooter>
            </form>
          </Card>
        </div>

        {/* Right col: Commercial Multi-Tenancy Architecture info */}
        <div className="space-y-6">
          {/* Subscription Tier Card */}
          <Card className="border-border/80 bg-card">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold">Workspace Plan</CardTitle>
                <Badge className="bg-primary text-primary-foreground text-xs uppercase font-mono">
                  {currentOrg?.plan || "Growth"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-muted-foreground">
              <div className="flex justify-between py-1 border-b border-border/60">
                <span>AI Employees Provisioned:</span>
                <strong className="text-foreground">3 of 4 Active</strong>
              </div>
              <div className="flex justify-between py-1 border-b border-border/60">
                <span>RFP Radar Quota:</span>
                <strong className="text-foreground">Unlimited Federal/State</strong>
              </div>
              <div className="flex justify-between py-1">
                <span>Data Isolation:</span>
                <strong className="text-emerald-600">Strict Tenant Scoped</strong>
              </div>
            </CardContent>
          </Card>

          {/* Multi-Tenant Monetization Readiness Card */}
          <Card className="border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                <Layers className="h-5 w-5" />
                <CardTitle className="text-sm font-bold">Selling to Other Practices</CardTitle>
              </div>
              <CardDescription className="text-xs text-emerald-900/80 dark:text-emerald-200/80 leading-relaxed pt-1">
                LeadDash Employees is architected from day one as a white-label multi-tenant SaaS. You can deploy isolated workspaces for any number of customer clinics, non-profits, or behavioral health networks.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span>Zero cross-tenant data leakage</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span>Turnkey AI Employee provisioning per client</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span>Tenant-scoped grounding knowledge and audit logs</span>
              </div>
            </CardContent>
            <CardFooter className="pt-2">
              <Button
                onClick={openCreateOrgModal}
                className="w-full text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus className="h-3.5 w-3.5" />
                Provision New Client Workspace
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
};
