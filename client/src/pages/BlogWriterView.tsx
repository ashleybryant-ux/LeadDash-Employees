import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmployeeAvatar } from "@/components/EmployeeAvatar";
import { Streamdown } from "streamdown";
import {
  FileCode,
  Globe,
  UploadCloud,
  Send,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  Plus,
  ShieldCheck,
  Eye,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";

export const BlogWriterView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();
  const [activeSubTab, setActiveSubTab] = useState<"articles" | "editor" | "new_article">("articles");
  const [selectedArticleId, setSelectedArticleId] = useState<number | null>(null);

  // New Article State
  const [articleTitle, setArticleTitle] = useState("");
  const [articleCategory, setArticleCategory] = useState("Clinical & Healthcare Innovations");
  const [outlineNotes, setOutlineNotes] = useState("");
  const [generateBannerFlag, setGenerateBannerFlag] = useState(true);

  const { data: employees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });
  const theo = employees?.find((e) => e.name.toLowerCase().includes("theo") || e.roleTitle.toLowerCase().includes("content") || e.roleTitle.toLowerCase().includes("wordpress"));

  const { data: articles, refetch: refetchArticles } = trpc.blog.listArticles.useQuery({ organizationId: currentOrgId });
  const { data: connections } = trpc.publishing.listConnections.useQuery({ organizationId: currentOrgId });
  const wpConn = connections?.find((c) => c.provider === "wordpress");

  const draftArticleMutation = trpc.blog.draftWordPressArticle.useMutation({
    onSuccess: (newItem) => {
      toast.success("Theo Bennett authored the comprehensive WordPress draft!");
      setArticleTitle("");
      setOutlineNotes("");
      if (newItem) setSelectedArticleId(newItem.id);
      setActiveSubTab("editor");
      refetchArticles();
    },
    onError: (err) => {
      toast.error("Article drafting failed: " + err.message);
    },
  });

  const approveMutation = trpc.publishing.approveAndDispatch.useMutation({
    onSuccess: (res) => {
      toast.success(`WordPress article approved! Status: ${res?.status}`);
      refetchArticles();
    },
    onError: (err) => {
      toast.error("Failed to approve article: " + err.message);
    },
  });

  const currentArticle = articles?.find((a) => a.id === selectedArticleId) || articles?.[0];

  return (
    <div className="space-y-6">
      {/* Theo Bennett Profile Header */}
      <div className="rounded-xl border border-primary/30 bg-card p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <EmployeeAvatar
              name={theo?.name || "Theo Bennett"}
              avatar={theo?.avatar}
              status="active"
              showStatus
              className="h-16 w-16"
            />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-foreground">
                  {theo?.name || "Theo Bennett"}
                </h1>
                <Badge className="bg-emerald-600 text-white text-[10px] px-2 py-0.5">
                  WORDPRESS BLOG WRITER
                </Badge>
              </div>
              <p className="text-xs text-primary font-medium">{theo?.roleTitle || "Long-Form Content & WordPress Specialist"}</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
                Authors publication-grade clinical and community articles, creates featured banner art, and stages each draft for an authenticated WordPress connection after human approval.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-muted/60 border border-border px-3 py-2 rounded-lg text-xs">
            <Globe className="h-4 w-4 text-primary" />
            <div>
              <span className="font-semibold block text-foreground">
                {wpConn?.accountLabel || "WordPress Site"}
              </span>
              <span className="text-[11px] text-muted-foreground font-mono">
                {wpConn?.accountHandle || "Connected via Application Passwords"}
              </span>
            </div>
          </div>
        </div>

        {/* Sub-tab Navigation */}
        <div className="flex items-center gap-2 mt-5 border-t border-border/60 pt-4">
          <Button
            variant={activeSubTab === "articles" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("articles")}
            className="text-xs gap-1.5"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Article Library ({articles?.length || 0})
          </Button>
          <Button
            variant={activeSubTab === "editor" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (articles && articles.length > 0 && !selectedArticleId) {
                setSelectedArticleId(articles[0].id);
              }
              setActiveSubTab("editor");
            }}
            className="text-xs gap-1.5"
          >
            <Eye className="h-3.5 w-3.5" />
            Reading & Approval View
          </Button>
          <Button
            variant={activeSubTab === "new_article" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("new_article")}
            className="text-xs gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Instruct Theo (New Blog Post)
          </Button>
        </div>
      </div>

      {/* Tab: Article Library */}
      {activeSubTab === "articles" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              WordPress Articles & Staged Drafts
            </h2>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Workspace: {currentOrg?.name}
            </Badge>
          </div>

          {!articles || articles.length === 0 ? (
            <Card className="p-8 text-center border-dashed">
              <FileCode className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm font-semibold text-foreground">No WordPress articles authored yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Instruct Theo to write an authoritative healthcare article for your blog.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {articles.map((art) => {
                let metadata: any = {};
                try {
                  metadata = art.metadata ? JSON.parse(art.metadata) : {};
                } catch (e) {}

                const isPending = art.status === "pending_approval";
                const isPublished = art.status === "published";

                return (
                  <Card key={art.id} className="border border-border/80 shadow-xs flex flex-col justify-between overflow-hidden">
                    <div>
                      {art.imageUrl && (
                        <div className="h-36 w-full overflow-hidden bg-muted relative">
                          <img
                            src={art.imageUrl}
                            alt={art.title}
                            className="w-full h-full object-cover"
                          />
                          <Badge className="absolute top-2 right-2 text-[10px] bg-black/60 text-white backdrop-blur-xs">
                            {metadata.category || "Healthcare"}
                          </Badge>
                        </div>
                      )}

                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <Badge
                            className={`text-[10px] ${
                              isPending
                                ? "bg-amber-500 text-white"
                                : isPublished
                                ? "bg-emerald-600 text-white"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {art.status.replace("_", " ").toUpperCase()}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {metadata.slug || "draft"}
                          </span>
                        </div>
                        <CardTitle className="text-base font-bold line-clamp-2">{art.title}</CardTitle>
                      </CardHeader>

                      <CardContent className="pb-3 text-xs text-muted-foreground line-clamp-3">
                        {art.body?.slice(0, 160)}...
                      </CardContent>
                    </div>

                    <CardFooter className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedArticleId(art.id);
                          setActiveSubTab("editor");
                        }}
                        className="text-xs gap-1"
                      >
                        <Eye className="h-3 w-3" />
                        Preview & Review
                      </Button>

                      {isPending && (
                        <Button
                          size="sm"
                          onClick={() =>
                            approveMutation.mutate({
                              organizationId: currentOrgId,
                              itemId: art.id,
                              action: "approve_for_dispatch",
                              reviewerName: "Dr. Marcus Vance",
                            })
                          }
                          className="text-xs bg-emerald-700 hover:bg-emerald-800 text-white gap-1"
                        >
                          <UploadCloud className="h-3 w-3" />
                          Approve for WordPress
                        </Button>
                      )}
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab: Reading & Approval View */}
      {activeSubTab === "editor" && currentArticle && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-border bg-card">
            <div>
              <div className="flex items-center gap-2">
                <Badge
                  className={`text-[10px] ${
                    currentArticle.status === "pending_approval"
                      ? "bg-amber-500 text-white"
                      : "bg-emerald-600 text-white"
                  }`}
                >
                  {currentArticle.status.replace("_", " ").toUpperCase()}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Target: {currentArticle.targetChannels || "WordPress REST API"}
                </span>
              </div>
              <h2 className="text-lg font-bold text-foreground mt-1">{currentArticle.title}</h2>
            </div>

            <div className="flex items-center gap-2">
              {currentArticle.status === "pending_approval" && (
                <Button
                  onClick={() =>
                    approveMutation.mutate({
                      organizationId: currentOrgId,
                      itemId: currentArticle.id,
                      action: "approve_for_dispatch",
                      reviewerName: "Dr. Marcus Vance",
                    })
                  }
                  className="text-xs bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
                >
                  <UploadCloud className="h-3.5 w-3.5" />
                  Approve for WordPress Dispatch
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Article Content */}
            <div className="lg:col-span-3 space-y-4">
              {currentArticle.imageUrl && (
                <div className="rounded-xl overflow-hidden border border-border max-h-[340px] w-full bg-muted">
                  <img
                    src={currentArticle.imageUrl}
                    alt={currentArticle.title}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              <Card className="border border-border p-6 font-serif leading-relaxed text-foreground bg-card">
                <Streamdown>{currentArticle.body || "No content."}</Streamdown>
              </Card>
            </div>

            {/* Meta Sidebar */}
            <div className="space-y-4">
              <Card className="border border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-xs font-semibold uppercase text-muted-foreground">
                    WordPress Publishing Metadata
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-xs">
                  <div>
                    <span className="text-[11px] text-muted-foreground block font-medium">Author</span>
                    <span className="text-foreground font-semibold">Theo Bennett (Reviewed by Dr. Vance)</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground block font-medium">API Endpoint</span>
                    <span className="font-mono text-[11px] text-primary truncate block">
                      https://insights.apexbehavioral.org/wp-json/wp/v2/posts
                    </span>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground block font-medium">Authentication</span>
                    <span className="text-foreground">Application Passwords (HTTPS Basic)</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground block font-medium">Safety Gate</span>
                    <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300">
                      Human Review Required
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* Tab: New Article Instruction */}
      {activeSubTab === "new_article" && (
        <Card className="border border-border max-w-3xl mx-auto">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <CardTitle className="text-base font-bold">Instruct Theo to Author a Blog Post</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Theo will draft a complete, evidence-based article and generate a custom banner graphic for your WordPress site.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1">Article Title / Core Topic</label>
              <Input
                value={articleTitle}
                onChange={(e) => setArticleTitle(e.target.value)}
                placeholder="e.g. Integrating Trauma-Informed Peer Navigation in Rural Community Clinics"
                className="text-xs"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">WordPress Category</label>
                <Input
                  value={articleCategory}
                  onChange={(e) => setArticleCategory(e.target.value)}
                  placeholder="Clinical & Practice Insights"
                  className="text-xs"
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/80 bg-muted/30">
                <div>
                  <span className="text-xs font-semibold text-foreground block">Generate Header Banner</span>
                  <span className="text-[11px] text-muted-foreground">High-resolution AI banner asset</span>
                </div>
                <input
                  type="checkbox"
                  checked={generateBannerFlag}
                  onChange={(e) => setGenerateBannerFlag(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground block mb-1">Key Clinical Themes / Outline Instructions</label>
              <Textarea
                value={outlineNotes}
                onChange={(e) => setOutlineNotes(e.target.value)}
                placeholder="Highlight 48-hour access, CARF compliance, peer navigator lived experience, and measurable patient stabilization rates..."
                className="text-xs min-h-[100px]"
              />
            </div>
          </CardContent>

          <CardFooter className="pt-3 border-t border-border flex justify-end">
            <Button
              disabled={draftArticleMutation.isPending || !articleTitle}
              onClick={() =>
                draftArticleMutation.mutate({
                  organizationId: currentOrgId,
                  title: articleTitle,
                  category: articleCategory,
                  outlineNotes,
                  generateBannerFlag,
                })
              }
              className="text-xs bg-primary text-primary-foreground gap-1.5"
            >
              {draftArticleMutation.isPending ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Theo is Writing Article & Banner...
                </>
              ) : (
                <>
                  <Sparkles className="h-3 w-3" />
                  Author Article & Generate Banner
                </>
              )}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
};
