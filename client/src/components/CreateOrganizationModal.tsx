import React, { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Building2, Sparkles, ShieldCheck } from "lucide-react";

export const CreateOrganizationModal: React.FC = () => {
  const { isCreateOrgModalOpen, closeCreateOrgModal, refetchOrgs, switchOrganization } = useTenant();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState<"starter" | "growth" | "enterprise">("growth");
  const [focusAreas, setFocusAreas] = useState("");
  const [annualBudget, setAnnualBudget] = useState("");
  const [state, setState] = useState("");
  const [ein, setEin] = useState("");

  const createMutation = trpc.organizations.create.useMutation({
    onSuccess: (data) => {
      toast.success(`Organization "${name}" created with Lead Grant Writer provisioned!`);
      refetchOrgs();
      if (data.id) {
        switchOrganization(data.id);
      }
      closeCreateOrgModal();
      // Reset form
      setName("");
      setSlug("");
      setFocusAreas("");
      setEin("");
      setState("");
    },
    onError: (err) => {
      toast.error("Failed to create organization: " + err.message);
    },
  });

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setName(val);
    if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, "-")) {
      setSlug(val.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) {
      toast.error("Please provide an organization name and URL slug");
      return;
    }
    createMutation.mutate({
      name,
      slug,
      plan,
      // Empty fields stay empty: the employees read these as facts, so no made-up defaults.
      focusAreas: focusAreas.trim() || undefined,
      annualBudget: annualBudget.trim() || undefined,
      state: state.trim() || undefined,
      ein: ein.trim() || undefined,
    });
  };

  return (
    <Dialog open={isCreateOrgModalOpen} onOpenChange={(open) => !open && closeCreateOrgModal()}>
      <DialogContent className="max-w-xl sm:max-w-2xl bg-card border-border">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Building2 className="h-5 w-5" />
            </div>
            <DialogTitle className="text-xl font-bold">New Organization Workspace</DialogTitle>
          </div>
          <DialogDescription>
            Deploy a dedicated, multi-tenant workspace with isolated data, grounding knowledge, and autonomous AI employees.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-name">Organization Name</Label>
              <Input
                id="org-name"
                placeholder="e.g. Cascade Valley Health Clinic"
                value={name}
                onChange={handleNameChange}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-slug">Workspace Identifier (Slug)</Label>
              <Input
                id="org-slug"
                placeholder="e.g. cascade-valley-health"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-plan">Subscription Plan</Label>
              <Select value={plan} onValueChange={(val: any) => setPlan(val)}>
                <SelectTrigger id="org-plan">
                  <SelectValue placeholder="Select plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter (1 Employee)</SelectItem>
                  <SelectItem value="growth">Growth (4 Employees)</SelectItem>
                  <SelectItem value="enterprise">Enterprise (Unlimited)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-budget">Annual Budget</Label>
              <Input
                id="org-budget"
                placeholder="e.g. $3,500,000"
                value={annualBudget}
                onChange={(e) => setAnnualBudget(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-state">State / Region</Label>
              <Input
                id="org-state"
                placeholder="e.g. Washington"
                value={state}
                onChange={(e) => setState(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-focus">Core Focus Areas & Mission Scope</Label>
            <Textarea
              id="org-focus"
              rows={2}
              placeholder="e.g. Outpatient Mental Health, Intensive Substance Use Recovery, Youth Crisis Intervention, Primary Care Telehealth"
              value={focusAreas}
              onChange={(e) => setFocusAreas(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The AI Grant Writer uses these focus areas to discover high-affinity RFPs and align scoring criteria.
            </p>
          </div>

          <div className="rounded-lg bg-muted/60 p-3 border border-border/80 flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Turnkey AI Provisioning:</span> Upon creation, your workspace will automatically be assigned an active <strong className="text-primary">Morgan Hayes (Lead Grant Writer)</strong> with full federal and foundation proposal drafting skills.
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={closeCreateOrgModal}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending} className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              {createMutation.isPending ? "Deploying Workspace..." : "Create Organization"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
