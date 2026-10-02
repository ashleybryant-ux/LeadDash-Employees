import React, { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { UserCheck, Sparkles, Bot, Briefcase } from "lucide-react";

interface HireEmployeeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export const HireEmployeeModal: React.FC<HireEmployeeModalProps> = ({ open, onOpenChange, onSuccess }) => {
  const { currentOrgId, currentOrg } = useTenant();

  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [description, setDescription] = useState("");
  const [capabilitiesStr, setCapabilitiesStr] = useState("");

  const hireMutation = trpc.employees.create.useMutation({
    onSuccess: () => {
      toast.success(`Hired AI Employee "${name}" for ${currentOrg?.name}!`);
      setName("");
      setRoleTitle("");
      setDepartment("");
      setDescription("");
      setCapabilitiesStr("");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err) => {
      toast.error("Failed to onboard employee: " + err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !roleTitle.trim()) {
      toast.error("Please enter a name and role title");
      return;
    }

    const capabilities = capabilitiesStr
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);

    hireMutation.mutate({
      organizationId: currentOrgId,
      name,
      roleTitle,
      department: department.trim() || "Operations",
      description: description.trim() || `${roleTitle} supporting ${currentOrg?.name}.`,
      capabilities: capabilities.length > 0 ? capabilities : [
        `Automated ${roleTitle} tasks`,
        "Workflow summarization & triage",
        "Pre-submission compliance verification"
      ],
    });
  };

  // Quick preset loader
  const loadPreset = (presetName: string, presetRole: string, presetDept: string, presetDesc: string, presetCaps: string) => {
    setName(presetName);
    setRoleTitle(presetRole);
    setDepartment(presetDept);
    setDescription(presetDesc);
    setCapabilitiesStr(presetCaps);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl bg-card border-border">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Bot className="h-5 w-5" />
            </div>
            <DialogTitle className="text-xl font-bold">Onboard a New AI Employee</DialogTitle>
          </div>
          <DialogDescription>
            Configure an autonomous employee for <strong>{currentOrg?.name}</strong> to handle ongoing business operations.
          </DialogDescription>
        </DialogHeader>

        {/* Quick presets */}
        <div className="space-y-1.5 py-1">
          <Label className="text-xs text-muted-foreground uppercase font-semibold">Popular AI Employee Presets</Label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() =>
                loadPreset(
                  "Sloan Parker",
                  "Quality & Compliance Auditor",
                  "Clinical Governance",
                  "Conducts automated chart completion audits, flags missing session notes, and verifies supervisor co-signature queues.",
                  "Chart completeness auditing\nCo-signature deadline tracking\nAudit trail anomaly detection"
                )
              }
            >
              + Compliance Auditor
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() =>
                loadPreset(
                  "Devon Price",
                  "Donor & Foundation Liaison",
                  "Advancement & Philanthropy",
                  "Cultivates recurring philanthropic relationships, drafts grant stewardship reports, and monitors foundation board giving cycles.",
                  "Foundation giving history research\nGrant impact report generation\nMajor donor briefing memorandums"
                )
              }
            >
              + Donor Liaison
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() =>
                loadPreset(
                  "Riley Chen",
                  "Billing Denial & Appeal Specialist",
                  "Revenue Cycle",
                  "Analyzes commercial and Medicaid claim rejections, extracts remark codes, and drafts timely filing appeal packages.",
                  "Denial code classification\nInsurance appeal packet assembly\nMedical necessity justification drafting"
                )
              }
            >
              + Denial Appeal Specialist
            </Button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="emp-name">Employee Name</Label>
              <Input
                id="emp-name"
                placeholder="e.g. Alex Sterling"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emp-role">Role Title</Label>
              <Input
                id="emp-role"
                placeholder="e.g. Partner Outreach Specialist"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="emp-dept">Department</Label>
            <Input
              id="emp-dept"
              placeholder="e.g. Strategic Growth / Clinical Ops"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="emp-desc">Role Description & Purpose</Label>
            <Textarea
              id="emp-desc"
              rows={2}
              placeholder="Describe what responsibilities this employee will own on an ongoing basis..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="emp-caps">Core Capabilities (one per line)</Label>
            <Textarea
              id="emp-caps"
              rows={3}
              placeholder="Requirement extraction&#10;Draft review&#10;Quality audit"
              value={capabilitiesStr}
              onChange={(e) => setCapabilitiesStr(e.target.value)}
            />
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={hireMutation.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {hireMutation.isPending ? "Deploying..." : "Onboard Employee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
