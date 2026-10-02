import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmployeeAvatar } from "@/components/EmployeeAvatar";
import {
  Share2,
  Image as ImageIcon,
  Send,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  Plus,
  ShieldCheck,
  Calendar,
  Layers,
} from "lucide-react";
import { toast } from "sonner";

export const SocialMediaView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();
  const [activeSubTab, setActiveSubTab] = useState<"queue" | "campaign_creator">("queue");

  // Form states
  const [topic, setTopic] = useState("");
  const [platforms, setPlatforms] = useState<("linkedin" | "instagram" | "facebook" | "x")[]>([
    "linkedin",
    "instagram",
    "facebook",
  ]);
  const [tone, setTone] = useState<
    "thought_leadership" | "community_announcement" | "clinical_advocacy" | "event_invitation"
  >("thought_leadership");
  const [generateImageFlag, setGenerateImageFlag] = useState(true);

  const { data: employees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });
  const sienna = employees?.find((e) => e.name.toLowerCase().includes("sienna") || e.roleTitle.toLowerCase().includes("social"));

  const { data: posts, refetch: refetchPosts } = trpc.social.listPosts.useQuery({ organizationId: currentOrgId });
  const { data: connections } = trpc.publishing.listConnections.useQuery({ organizationId: currentOrgId });

  const createPostMutation = trpc.social.generatePostAndCreative.useMutation({
    onSuccess: () => {
      toast.success("Sienna generated the post copy and visual creative!");
      setTopic("");
      setActiveSubTab("queue");
      refetchPosts();
    },
    onError: (err) => {
      toast.error("Generation failed: " + err.message);
    },
  });

  const approveMutation = trpc.publishing.approveAndDispatch.useMutation({
    onSuccess: (res) => {
      toast.success(`Social campaign approved! Status: ${res?.status}`);
      refetchPosts();
    },
    onError: (err) => {
      toast.error("Failed to approve post: " + err.message);
    },
  });

  const togglePlatform = (p: "linkedin" | "instagram" | "facebook" | "x") => {
    if (platforms.includes(p)) {
      if (platforms.length > 1) {
        setPlatforms(platforms.filter((item) => item !== p));
      }
    } else {
      setPlatforms([...platforms, p]);
    }
  };

  return (
    <div className="space-y-6">
      {/* Sienna Martinez Profile Header */}
      <div className="rounded-xl border border-primary/30 bg-card p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <EmployeeAvatar
              name={sienna?.name || "Sienna Martinez"}
              avatar={sienna?.avatar}
              status="active"
              showStatus
              className="h-16 w-16"
            />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-foreground">
                  {sienna?.name || "Sienna Martinez"}
                </h1>
                <Badge className="bg-emerald-600 text-white text-[10px] px-2 py-0.5">
                  SOCIAL MEDIA STRATEGIST
                </Badge>
              </div>
              <p className="text-xs text-primary font-medium">{sienna?.roleTitle || "Social Media & Visual Campaign Strategist"}</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
                Plans multi-channel campaigns, drafts engaging platform-specific copy, creates branded visual artwork, and stages each campaign for approval before connected social channels can dispatch it.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex flex-wrap gap-1.5 max-w-xs">
              {["LinkedIn", "Instagram", "Facebook", "WordPress"].map((ch, i) => (
                <Badge key={i} variant="outline" className="text-[10px] bg-muted/40 border-border font-normal">
                  {ch}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        {/* Sub-tab Navigation */}
        <div className="flex items-center gap-2 mt-5 border-t border-border/60 pt-4">
          <Button
            variant={activeSubTab === "queue" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("queue")}
            className="text-xs gap-1.5"
          >
            <Share2 className="h-3.5 w-3.5" />
            Social Campaign Queue ({posts?.length || 0})
          </Button>
          <Button
            variant={activeSubTab === "campaign_creator" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("campaign_creator")}
            className="text-xs gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Instruct Sienna (New Post & Visual)
          </Button>
        </div>
      </div>

      {/* Tab: Social Queue */}
      {activeSubTab === "queue" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Social Posts & Artwork Approval Queue
            </h2>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Workspace: {currentOrg?.name}
            </Badge>
          </div>

          {!posts || posts.length === 0 ? (
            <Card className="p-8 text-center border-dashed">
              <Share2 className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm font-semibold text-foreground">No social campaigns queued</p>
              <p className="text-xs text-muted-foreground mt-1">
                Instruct Sienna to draft a new campaign with custom copy and generated visuals.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-6">
              {posts.map((post) => {
                let channels: string[] = [];
                try {
                  channels = post.targetChannels ? JSON.parse(post.targetChannels) : [];
                } catch (e) {}

                const isPending = post.status === "pending_approval";
                const isPublished = post.status === "published";

                return (
                  <Card key={post.id} className="border border-border/80 shadow-xs overflow-hidden">
                    <CardHeader className="pb-3 bg-muted/20 border-b border-border/40">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-base font-bold">{post.title}</CardTitle>
                            <Badge
                              className={`text-[10px] ${
                                isPending
                                  ? "bg-amber-500 text-white"
                                  : isPublished
                                  ? "bg-emerald-600 text-white"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {post.status.replace("_", " ").toUpperCase()}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground">Target Platforms:</span>
                            <div className="flex gap-1">
                              {channels.map((ch, i) => (
                                <Badge key={i} variant="secondary" className="text-[10px] uppercase font-mono">
                                  {ch}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>

                        {post.externalReference && (
                          <span className="text-[11px] font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground">
                            {post.externalReference}
                          </span>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* Left 2 Cols: Copy */}
                      <div className="md:col-span-2 space-y-3">
                        <div className="p-3.5 rounded-lg bg-card border border-border/60 text-xs font-sans whitespace-pre-wrap leading-relaxed text-foreground">
                          {post.body}
                        </div>
                      </div>

                      {/* Right 1 Col: Visual Creative */}
                      <div className="space-y-2">
                        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                          <ImageIcon className="h-3.5 w-3.5 text-primary" />
                          Generated Campaign Visual
                        </span>
                        {post.imageUrl ? (
                          <div className="rounded-lg overflow-hidden border border-border/80 bg-muted/40 aspect-square flex items-center justify-center relative group">
                            <img
                              src={post.imageUrl}
                              alt={post.title}
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <a
                                href={post.imageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-white underline font-medium"
                              >
                                View Full Image
                              </a>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                            Text-only campaign (no visual attached)
                          </div>
                        )}
                      </div>
                    </CardContent>

                    <CardFooter className="pt-2 pb-3 px-4 border-t border-border/60 bg-muted/10 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                        <span>{post.approvedBy ? `Approved by ${post.approvedBy}` : "Requires human sign-off before dispatch"}</span>
                      </div>

                      {isPending && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId: currentOrgId,
                                itemId: post.id,
                                action: "request_revisions",
                                reviewerName: "Dr. Marcus Vance",
                              })
                            }
                            className="text-xs"
                          >
                            Request Edits
                          </Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId: currentOrgId,
                                itemId: post.id,
                                action: "approve_for_dispatch",
                                reviewerName: "Dr. Marcus Vance",
                              })
                            }
                            className="text-xs bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
                          >
                            <Send className="h-3 w-3" />
                            Approve for Channel Dispatch
                          </Button>
                        </div>
                      )}
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab: Campaign Creator */}
      {activeSubTab === "campaign_creator" && (
        <Card className="border border-border max-w-3xl mx-auto">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <CardTitle className="text-base font-bold">Instruct Sienna to Create a Social Campaign</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Sienna will generate multi-platform copy and an AI visual asset tailored to your clinic's brand.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1">Campaign Topic / Announcement</label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Free Community Adolescent Mental Health Screenings Every Saturday in October"
                className="text-xs"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground block mb-1">Target Social Platforms</label>
              <div className="flex flex-wrap gap-2">
                {(["linkedin", "instagram", "facebook", "x"] as const).map((p) => {
                  const isSelected = platforms.includes(p);
                  return (
                    <Button
                      key={p}
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      onClick={() => togglePlatform(p)}
                      className="text-xs uppercase font-mono"
                    >
                      {p}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Tone & Voice</label>
                <select
                  value={tone}
                  onChange={(e: any) => setTone(e.target.value)}
                  className="w-full text-xs rounded-md border border-input bg-background px-3 py-2 text-foreground"
                >
                  <option value="thought_leadership">Thought Leadership (Professional, Authoritative)</option>
                  <option value="community_announcement">Community Announcement (Warm, Welcoming)</option>
                  <option value="clinical_advocacy">Clinical Advocacy (Evidence-Grounded)</option>
                  <option value="event_invitation">Event / Webinar Invitation</option>
                </select>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/80 bg-muted/30">
                <div>
                  <span className="text-xs font-semibold text-foreground block">Generate AI Visual Creative</span>
                  <span className="text-[11px] text-muted-foreground">Render custom LeadDash-branded artwork</span>
                </div>
                <input
                  type="checkbox"
                  checked={generateImageFlag}
                  onChange={(e) => setGenerateImageFlag(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary"
                />
              </div>
            </div>
          </CardContent>

          <CardFooter className="pt-3 border-t border-border flex justify-end">
            <Button
              disabled={createPostMutation.isPending || !topic}
              onClick={() =>
                createPostMutation.mutate({
                  organizationId: currentOrgId,
                  topic,
                  targetPlatforms: platforms,
                  tone,
                  generateImageFlag,
                })
              }
              className="text-xs bg-primary text-primary-foreground gap-1.5"
            >
              {createPostMutation.isPending ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Sienna is Drafting Post & Creative...
                </>
              ) : (
                <>
                  <Sparkles className="h-3 w-3" />
                  Generate Campaign Draft & Creative
                </>
              )}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
};
