import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Database,
  Plus,
  Sparkles,
  ShieldCheck,
  Award,
  Users,
  DollarSign,
  FileBadge,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export const KnowledgeBaseView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState<
    "mission_profile" | "past_performance" | "certifications_licenses" | "team_bios" | "financial_data"
  >("mission_profile");
  const [newContent, setNewContent] = useState("");

  const { data: knowledgeItems, refetch } = trpc.knowledge.list.useQuery({ organizationId: currentOrgId });

  const createMutation = trpc.knowledge.create.useMutation({
    onSuccess: () => {
      toast.success("Grounding fact added! Morgan Hayes and other AI employees will cite this record.");
      refetch();
      setIsAddModalOpen(false);
      setNewTitle("");
      setNewContent("");
    },
    onError: (err) => {
      toast.error("Failed to add knowledge: " + err.message);
    },
  });

  const categoryLabels: Record<string, { label: string; icon: any; color: string }> = {
    mission_profile: { label: "Mission & Clinical Profile", icon: Award, color: "text-blue-600 bg-blue-500/10" },
    past_performance: { label: "Past Performance & Prior Grants", icon: CheckCircle2, color: "text-emerald-600 bg-emerald-500/10" },
    certifications_licenses: { label: "Licenses, CARF & Accreditations", icon: FileBadge, color: "text-purple-600 bg-purple-500/10" },
    team_bios: { label: "Clinical Leadership Bios", icon: Users, color: "text-amber-600 bg-amber-500/10" },
    financial_data: { label: "Financial Data & Audits", icon: DollarSign, color: "text-teal-600 bg-teal-500/10" },
  };

  const filteredItems = knowledgeItems?.filter((item) => {
    if (selectedCategory === "all") return true;
    return item.category === selectedCategory;
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      toast.error("Please enter a title and content");
      return;
    }
    createMutation.mutate({
      organizationId: currentOrgId,
      title: newTitle.trim(),
      category: newCategory,
      content: newContent.trim(),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Grounding Knowledge Base
          </h1>
          <p className="text-xs text-muted-foreground">
            Verified factual assets for <strong>{currentOrg?.name}</strong>. Morgan Hayes and your AI employees cite these authentic records when writing proposals to prevent hallucinations.
          </p>
        </div>

        <Button
          onClick={() => setIsAddModalOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Add Grounding Fact
        </Button>
      </div>

      {/* Category filter pills */}
      <div className="flex flex-wrap gap-2 pb-1">
        <Button
          variant={selectedCategory === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedCategory("all")}
          className="text-xs h-8"
        >
          All Categories ({knowledgeItems?.length || 0})
        </Button>
        {Object.entries(categoryLabels).map(([catKey, info]) => (
          <Button
            key={catKey}
            variant={selectedCategory === catKey ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCategory(catKey)}
            className="text-xs h-8 gap-1.5"
          >
            <info.icon className="h-3 w-3" />
            {info.label}
          </Button>
        ))}
      </div>

      {/* Knowledge Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredItems?.map((item) => {
          const catInfo = categoryLabels[item.category] || categoryLabels.mission_profile;
          const Icon = catInfo.icon;
          return (
            <Card key={item.id} className="border-border/80 bg-card shadow-xs hover:border-primary/30 transition-all flex flex-col justify-between">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge variant="outline" className={`text-[10px] gap-1 px-2 py-0.5 border-border ${catInfo.color}`}>
                    <Icon className="h-3 w-3" />
                    {catInfo.label}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    ID: KB-{item.id}
                  </span>
                </div>
                <CardTitle className="text-base font-bold text-foreground">{item.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground leading-relaxed">
                {item.content}
              </CardContent>
              <CardFooter className="pt-2 border-t border-border/50 text-[11px] text-muted-foreground flex items-center justify-between">
                <span className="flex items-center gap-1 text-emerald-600 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Grounded & Cited by Morgan Hayes
                </span>
                <span>{new Date(item.createdAt).toLocaleDateString()}</span>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {/* Add Grounding Fact Modal */}
      <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
        <DialogContent className="max-w-xl bg-card border-border">
          <DialogHeader>
            <div className="flex items-center gap-2 mb-1">
              <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Database className="h-5 w-5" />
              </div>
              <DialogTitle className="text-lg font-bold">Add Verified Grounding Fact</DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              Provide organizational data, past awards, licenses, or leadership bios to ground future proposal generations.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="kb-category" className="text-xs">Category</Label>
              <Select value={newCategory} onValueChange={(val: any) => setNewCategory(val)}>
                <SelectTrigger id="kb-category" className="text-xs">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mission_profile">Mission & Clinical Profile</SelectItem>
                  <SelectItem value="past_performance">Past Performance & Prior Grants</SelectItem>
                  <SelectItem value="certifications_licenses">Licenses, CARF & Accreditations</SelectItem>
                  <SelectItem value="team_bios">Clinical Leadership Bios</SelectItem>
                  <SelectItem value="financial_data">Financial Data & Audits</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="kb-title" className="text-xs">Fact Title / Headline</Label>
              <Input
                id="kb-title"
                placeholder="e.g. 2024 State Behavioral Health Outcomes & Retention Data"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                required
                className="text-xs"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="kb-content" className="text-xs">Factual Content & Metrics</Label>
              <Textarea
                id="kb-content"
                rows={5}
                placeholder="Include specific dates, metrics, percentages, grant award amounts, agency partner names, or license numbers..."
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                required
                className="text-xs leading-relaxed"
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setIsAddModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs">
                {createMutation.isPending ? "Adding Fact..." : "Save Grounding Record"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
