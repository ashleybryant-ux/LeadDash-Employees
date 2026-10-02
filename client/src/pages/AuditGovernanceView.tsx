import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  History,
  Bot,
  User,
  ShieldCheck,
  Search,
  CheckCircle2,
  Lock,
  Layers,
} from "lucide-react";

export const AuditGovernanceView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();
  const [filterType, setFilterType] = useState<"all" | "employee" | "human_user" | "system">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: auditLogs, isLoading } = trpc.audit.list.useQuery({
    organizationId: currentOrgId,
    limit: 50,
  });

  const filteredLogs = auditLogs?.filter((log) => {
    if (filterType !== "all" && log.actorType !== filterType) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        log.actorName.toLowerCase().includes(q) ||
        log.action.toLowerCase().includes(q) ||
        (log.details && log.details.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Audit Governance & Traceability
          </h1>
          <p className="text-xs text-muted-foreground">
            Immutable activity log tracking every autonomous discovery, AI drafting step, and human verification decision for <strong>{currentOrg?.name}</strong>.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs bg-muted/60 border border-border px-3 py-1.5 rounded-lg text-muted-foreground">
          <Lock className="h-3.5 w-3.5 text-primary" />
          <span>Tenant Isolated & Tamper-Evident</span>
        </div>
      </div>

      {/* Filter and search bar */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <Button
            variant={filterType === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("all")}
            className="text-xs h-8"
          >
            All Activity ({auditLogs?.length || 0})
          </Button>
          <Button
            variant={filterType === "employee" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("employee")}
            className="text-xs h-8 gap-1.5"
          >
            <Bot className="h-3.5 w-3.5" />
            AI Employees
          </Button>
          <Button
            variant={filterType === "human_user" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("human_user")}
            className="text-xs h-8 gap-1.5"
          >
            <User className="h-3.5 w-3.5" />
            Human Reviewers
          </Button>
          <Button
            variant={filterType === "system" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("system")}
            className="text-xs h-8 gap-1.5"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            System & Policies
          </Button>
        </div>

        <div className="w-full sm:w-64">
          <Input
            placeholder="Search action or details..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="text-xs h-8 bg-card"
          />
        </div>
      </div>

      {/* Audit Log Table */}
      <Card className="border-border/80">
        <div className="divide-y divide-border/60">
          {filteredLogs?.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No audit records match the selected filter.
            </div>
          ) : (
            filteredLogs?.map((log) => (
              <div key={log.id} className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3 text-xs hover:bg-muted/30 transition-colors">
                <div className="flex items-start gap-3">
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                    log.actorType === "employee"
                      ? "bg-primary/10 text-primary"
                      : log.actorType === "human_user"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : "bg-blue-500/10 text-blue-600"
                  }`}>
                    {log.actorType === "employee" ? (
                      <Bot className="h-4 w-4" />
                    ) : log.actorType === "human_user" ? (
                      <ShieldCheck className="h-4 w-4" />
                    ) : (
                      <History className="h-4 w-4" />
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">{log.actorName}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 uppercase font-mono">
                        {log.actorType.replace("_", " ")}
                      </Badge>
                    </div>
                    <div className="font-semibold text-primary">{log.action}</div>
                    <p className="text-muted-foreground leading-relaxed max-w-3xl">
                      {log.details}
                    </p>
                  </div>
                </div>

                <div className="text-[11px] text-muted-foreground shrink-0 font-mono self-start sm:self-center">
                  {new Date(log.createdAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
};
