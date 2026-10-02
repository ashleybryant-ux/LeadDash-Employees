import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Share2,
  Globe,
  Mail,
  Calendar,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Settings2,
  RefreshCw,
  Send,
  Plus,
  KeyRound,
  Lock,
} from "lucide-react";
import { toast } from "sonner";

export const PublishingChannelsView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();
  const [activeTab, setActiveTab] = useState<"connections" | "approval_queue">("connections");
  const [filterKind, setFilterKind] = useState<string>("all");

  // Configuration modal state
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [selectedConn, setSelectedConn] = useState<any>(null);
  const [accountLabel, setAccountLabel] = useState("");
  const [accountHandle, setAccountHandle] = useState("");
  const [connStatus, setConnStatus] = useState<"connected" | "disconnected" | "pending">("pending");

  // Provider-specific credential fields
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [wpUsername, setWpUsername] = useState("");
  const [pageOrAccountId, setPageOrAccountId] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");

  const { data: connections, refetch: refetchConnections } = trpc.publishing.listConnections.useQuery({
    organizationId: currentOrgId,
  });

  const { data: queueItems, refetch: refetchQueue } = trpc.publishing.listApprovalQueue.useQuery({
    organizationId: currentOrgId,
  });

  const updateConnMutation = trpc.publishing.updateConnection.useMutation({
    onSuccess: (res) => {
      toast.success(`Connection ${res?.accountLabel} settings and credentials saved!`);
      setConfigModalOpen(false);
      refetchConnections();
    },
    onError: (err) => {
      toast.error("Failed to update connection: " + err.message);
    },
  });

  const approveMutation = trpc.publishing.approveAndDispatch.useMutation({
    onSuccess: (res) => {
      toast.success(`Item updated to ${res?.status}!`);
      refetchQueue();
    },
    onError: (err) => {
      toast.error("Approval action failed: " + err.message);
    },
  });

  const openConfigModal = (conn: any) => {
    setSelectedConn(conn);
    setAccountLabel(conn.accountLabel);
    setAccountHandle(conn.accountHandle || "");
    setConnStatus(conn.status);

    let parsedSettings: any = {};
    try {
      parsedSettings = conn.settings ? JSON.parse(conn.settings) : {};
    } catch (e) {}

    setClientId(parsedSettings.clientId || "");
    setClientSecret(parsedSettings.clientSecret || "");
    setWpAppPassword(parsedSettings.appPassword || "");
    setWpUsername(parsedSettings.username || "");
    setPageOrAccountId(parsedSettings.pageId || parsedSettings.pageUrn || parsedSettings.accountId || "");
    setAdditionalNotes(parsedSettings.notes || "");

    setConfigModalOpen(true);
  };

  const handleSaveConnection = () => {
    if (!selectedConn) return;

    const structuredSettings: Record<string, any> = {
      notes: additionalNotes,
    };

    if (selectedConn.provider === "google_workspace") {
      structuredSettings.clientId = clientId;
      if (clientSecret) structuredSettings.clientSecret = clientSecret;
      structuredSettings.authModel = "OAuth 2.0 (Restricted Scopes: Gmail + Calendar)";
    } else if (selectedConn.provider === "linkedin") {
      structuredSettings.clientId = clientId;
      if (clientSecret) structuredSettings.clientSecret = clientSecret;
      structuredSettings.pageUrn = pageOrAccountId;
      structuredSettings.authModel = "OAuth 2.0 (w_organization_social)";
    } else if (selectedConn.provider === "facebook" || selectedConn.provider === "instagram") {
      structuredSettings.appId = clientId;
      if (clientSecret) structuredSettings.appSecret = clientSecret;
      structuredSettings.pageId = pageOrAccountId;
      structuredSettings.authModel = "Meta Graph API (pages_manage_posts, instagram_content_publish)";
    } else if (selectedConn.provider === "wordpress") {
      structuredSettings.username = wpUsername;
      if (wpAppPassword) structuredSettings.appPassword = wpAppPassword;
      structuredSettings.endpoint = accountHandle;
      structuredSettings.authModel = "Application Passwords (HTTPS Basic Auth)";
    } else if (selectedConn.provider === "x") {
      structuredSettings.clientId = clientId;
      if (clientSecret) structuredSettings.clientSecret = clientSecret;
      structuredSettings.authModel = "OAuth 2.0 PKCE (tweet.write)";
    }

    updateConnMutation.mutate({
      organizationId: currentOrgId,
      provider: selectedConn.provider,
      accountLabel,
      accountHandle,
      status: connStatus,
      settings: JSON.stringify(structuredSettings),
    });
  };

  const filteredItems = queueItems?.filter((item) => {
    if (filterKind === "all") return true;
    return item.kind === filterKind;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Channel Integrations & Publishing Governance
          </h1>
          <p className="text-xs text-muted-foreground">
            Configure tenant-isolated social, email, and WordPress publishing endpoints with pre-submission human approval safeguards.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant={activeTab === "connections" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("connections")}
            className="text-xs gap-1.5"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Connected Accounts ({connections?.length || 0})
          </Button>
          <Button
            variant={activeTab === "approval_queue" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("approval_queue")}
            className="text-xs gap-1.5"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Global Approval Queue ({queueItems?.length || 0})
          </Button>
        </div>
      </div>

      {/* Tab: Connected Accounts */}
      {activeTab === "connections" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {connections?.map((conn) => {
              let caps: string[] = [];
              try {
                caps = conn.capabilities ? JSON.parse(conn.capabilities) : [];
              } catch (e) {}

              const isConnected = conn.status === "connected";
              const isPending = conn.status === "pending";

              return (
                <Card key={conn.id} className="border border-border/80 shadow-xs flex flex-col justify-between">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Badge variant="outline" className="text-[10px] uppercase font-mono mb-1 text-primary">
                          {conn.provider.replace("_", " ")}
                        </Badge>
                        <CardTitle className="text-base font-bold">{conn.accountLabel}</CardTitle>
                        <p className="text-xs font-mono text-muted-foreground mt-0.5 truncate max-w-[220px]">
                          {conn.accountHandle || "Pending connection"}
                        </p>
                      </div>

                      <Badge
                        className={`text-[10px] ${
                          isConnected
                            ? "bg-emerald-600 text-white"
                            : isPending
                            ? "bg-amber-500 text-white"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {conn.status.toUpperCase()}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-3 pb-3 text-xs">
                    <div>
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase block mb-1">
                        Active Scopes / Capabilities
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {caps.map((c, i) => (
                          <Badge key={i} variant="secondary" className="text-[10px] font-mono py-0">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60 text-[11px] space-y-1">
                      <div className="flex justify-between text-muted-foreground">
                        <span>Tenant Isolation:</span>
                        <strong className="text-foreground">{currentOrg?.name}</strong>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Pre-Flight Human Sign-Off:</span>
                        <strong className="text-emerald-600">Active</strong>
                      </div>
                    </div>
                  </CardContent>

                  <CardFooter className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openConfigModal(conn)}
                      className="text-xs gap-1.5"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Configure Settings
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        toast.info(
                          `${conn.accountLabel} is bound to organization ${currentOrg?.name}. Client secrets and application passwords are encrypted on the server.`
                        )
                      }
                      className="text-xs text-muted-foreground gap-1"
                    >
                      <Lock className="h-3 w-3" />
                      Security Audit
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>

          {/* Integration Setup Note */}
          <Card className="border-dashed border-border bg-muted/20 p-5">
            <div className="flex items-start gap-3">
              <KeyRound className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs">
                <h3 className="font-bold text-foreground text-sm">Enterprise Multi-Tenant OAuth Security Standard</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Each organization workspace securely isolates its external credentials. Google Workspace tokens utilize restricted-scope OAuth 2.0 with incremental authorization; LinkedIn utilizes Page Administrator delegations; Meta requires linked Facebook Page permissions; and WordPress connects via per-user Application Passwords over HTTPS. All outbound drafts require a signed human approval record before any external transmission occurs.
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Tab: Global Approval Queue */}
      {activeTab === "approval_queue" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {["all", "email_draft", "calendar_hold", "social_post", "blog_post"].map((k) => (
                <Button
                  key={k}
                  variant={filterKind === k ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilterKind(k)}
                  className="text-xs capitalize font-mono"
                >
                  {k.replace("_", " ")}
                </Button>
              ))}
            </div>

            <Badge variant="outline" className="text-xs text-muted-foreground">
              Workspace: {currentOrg?.name}
            </Badge>
          </div>

          {!filteredItems || filteredItems.length === 0 ? (
            <Card className="p-8 text-center border-dashed">
              <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm font-semibold text-foreground">All items reviewed and dispatched</p>
              <p className="text-xs text-muted-foreground mt-1">
                New drafts prepared by your AI employees will appear here for verification.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {filteredItems.map((item) => {
                const isPending = item.status === "pending_approval";
                const isApproved = item.status === "approved";

                return (
                  <Card key={item.id} className="border border-border/80 shadow-xs">
                    <CardHeader className="pb-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[10px] uppercase font-mono text-primary">
                              {item.kind.replace("_", " ")}
                            </Badge>
                            <CardTitle className="text-base font-bold">{item.title}</CardTitle>
                            <Badge
                              className={`text-[10px] ${
                                isPending
                                  ? "bg-amber-500 text-white"
                                  : isApproved
                                  ? "bg-emerald-600 text-white"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {item.status.replace("_", " ").toUpperCase()}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Target Channels: <strong className="text-foreground">{item.targetChannels || "External Provider"}</strong>
                          </p>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="pb-3">
                      <div className="p-3.5 rounded-lg bg-muted/40 border border-border/60 text-xs font-sans whitespace-pre-wrap leading-relaxed text-foreground max-h-48 overflow-y-auto">
                        {item.body}
                      </div>
                    </CardContent>

                    <CardFooter className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {item.approvedBy ? `Authorized by ${item.approvedBy}` : "Pending human verification"}
                      </span>

                      {isPending && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId: currentOrgId,
                                itemId: item.id,
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
                                itemId: item.id,
                                action: "approve_for_dispatch",
                                reviewerName: "Dr. Marcus Vance",
                              })
                            }
                            className="text-xs bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
                          >
                            <Send className="h-3 w-3" />
                            Approve for External Dispatch
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

      {/* Provider-Specific Connection Configuration Dialog */}
      <Dialog open={configModalOpen} onOpenChange={setConfigModalOpen}>
        <DialogContent className="max-w-lg bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">
              Configure {selectedConn?.provider?.replace("_", " ").toUpperCase()} Connection
            </DialogTitle>
            <DialogDescription className="text-xs">
              Manage endpoint identifiers, target handle, and tenant authorization parameters for <strong>{currentOrg?.name}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="font-semibold block mb-1">Account / Profile Label</label>
                <Input
                  value={accountLabel}
                  onChange={(e) => setAccountLabel(e.target.value)}
                  placeholder="e.g. Primary Executive Mailbox"
                  className="text-xs"
                />
              </div>

              <div>
                <label className="font-semibold block mb-1">Handle / Target URL / Email</label>
                <Input
                  value={accountHandle}
                  onChange={(e) => setAccountHandle(e.target.value)}
                  placeholder="e.g. director@clinic.org"
                  className="text-xs"
                />
              </div>
            </div>

            <div>
              <label className="font-semibold block mb-1">Connection State</label>
              <select
                value={connStatus}
                onChange={(e: any) => setConnStatus(e.target.value)}
                className="w-full text-xs rounded-md border border-input bg-background px-3 py-2 text-foreground"
              >
                <option value="pending">Pending Configuration</option>
                <option value="connected">Connected & Authorized</option>
                <option value="disconnected">Disconnected</option>
              </select>
            </div>

            {/* Provider Specific Credential Inputs */}
            {selectedConn?.provider === "wordpress" ? (
              <div className="space-y-3 p-3.5 rounded-lg border border-border/80 bg-muted/30">
                <span className="font-bold text-foreground block text-[11px] uppercase tracking-wider">
                  WordPress Application Credentials
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                      WordPress Username
                    </label>
                    <Input
                      value={wpUsername}
                      onChange={(e) => setWpUsername(e.target.value)}
                      placeholder="e.g. theo_editor"
                      className="text-xs bg-background"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                      Application Password
                    </label>
                    <Input
                      type="password"
                      value={wpAppPassword}
                      onChange={(e) => setWpAppPassword(e.target.value)}
                      placeholder="•••• •••• •••• ••••"
                      className="text-xs font-mono bg-background"
                    />
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground block">
                  Generated in WordPress Admin &gt; Users &gt; Profile &gt; Application Passwords.
                </span>
              </div>
            ) : selectedConn?.provider === "linkedin" ||
              selectedConn?.provider === "facebook" ||
              selectedConn?.provider === "instagram" ? (
              <div className="space-y-3 p-3.5 rounded-lg border border-border/80 bg-muted/30">
                <span className="font-bold text-foreground block text-[11px] uppercase tracking-wider">
                  Social Platform App & Page Credentials
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                      OAuth App / Client ID
                    </label>
                    <Input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="e.g. 86ab94c2018..."
                      className="text-xs bg-background"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                      App Secret / Token Key
                    </label>
                    <Input
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder="••••••••••••••••"
                      className="text-xs font-mono bg-background"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                    Target Page ID / Organization URN
                  </label>
                  <Input
                    value={pageOrAccountId}
                    onChange={(e) => setPageOrAccountId(e.target.value)}
                    placeholder="e.g. urn:li:organization:8492041 or Facebook Page ID"
                    className="text-xs font-mono bg-background"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-3.5 rounded-lg border border-border/80 bg-muted/30">
                <span className="font-bold text-foreground block text-[11px] uppercase tracking-wider">
                  OAuth 2.0 Client Credentials
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                      Client ID
                    </label>
                    <Input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="e.g. 104928192-apps.googleusercontent.com"
                      className="text-xs bg-background"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                      Client Secret
                    </label>
                    <Input
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder="••••••••••••••••"
                      className="text-xs font-mono bg-background"
                    />
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="font-semibold block mb-1">Deployment Notes</label>
              <Input
                value={additionalNotes}
                onChange={(e) => setAdditionalNotes(e.target.value)}
                placeholder="e.g. Restricted OAuth scope verified with clinic IT committee."
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfigModalOpen(false)}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={updateConnMutation.isPending || !accountLabel}
              onClick={handleSaveConnection}
              className="text-xs bg-primary text-primary-foreground"
            >
              Save Credentials & Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
