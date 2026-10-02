import React, { useState } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HireEmployeeModal } from "@/components/HireEmployeeModal";
import { EmployeeAvatar } from "@/components/EmployeeAvatar";
import {
  Bot,
  Plus,
  Play,
  Pause,
  Clock,
  Sparkles,
  ShieldCheck,
  CheckCircle2,
  Briefcase,
  Layers,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

interface EmployeesRosterViewProps {
  onOpenGrantWriter: () => void;
}

export const EmployeesRosterView: React.FC<EmployeesRosterViewProps> = ({ onOpenGrantWriter }) => {
  const { currentOrgId, currentOrg } = useTenant();
  const [isHireModalOpen, setIsHireModalOpen] = useState(false);

  const { data: employees, refetch } = trpc.employees.list.useQuery({ organizationId: currentOrgId });

  const toggleMutation = trpc.employees.toggleStatus.useMutation({
    onSuccess: (emp) => {
      toast.success(`${emp?.name} status updated to ${emp?.status}!`);
      refetch();
    },
    onError: (err) => {
      toast.error("Failed to update employee: " + err.message);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            AI Employees Directory
          </h1>
          <p className="text-xs text-muted-foreground">
            Manage your digital workforce, inspect active responsibilities, and onboard specialized employees for <strong>{currentOrg?.name}</strong>.
          </p>
        </div>

        <Button
          onClick={() => setIsHireModalOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Onboard New Employee
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {employees?.map((emp) => {
          let capabilities: string[] = [];
          try {
            if (emp.capabilities) {
              capabilities = JSON.parse(emp.capabilities);
            }
          } catch (e) {
            capabilities = [];
          }

          const isActive = emp.status === "active" || emp.status === "working";
          const isGrantWriter = emp.name.toLowerCase().includes("morgan") || emp.roleTitle.toLowerCase().includes("grant");

          return (
            <Card
              key={emp.id}
              className={`border transition-all flex flex-col justify-between ${
                isGrantWriter
                  ? "border-primary/40 bg-card shadow-xs"
                  : "border-border/80 bg-card hover:border-primary/30"
              }`}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <EmployeeAvatar name={emp.name} avatar={emp.avatar} status={emp.status} showStatus className="h-12 w-12" />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <CardTitle className="text-base font-bold">{emp.name}</CardTitle>
                        <Badge
                          className={`text-[10px] px-1.5 py-0 h-4 ${
                            isActive ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {emp.status.toUpperCase()}
                        </Badge>
                      </div>
                      <p className="text-xs font-semibold text-primary">{emp.roleTitle}</p>
                      <p className="text-[11px] text-muted-foreground">{emp.department}</p>
                    </div>
                  </div>
                </div>

                <CardDescription className="text-xs mt-3 leading-relaxed">
                  {emp.description}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4 pb-3">
                {/* Stats row */}
                <div className="grid grid-cols-2 gap-2 text-center text-xs p-2 rounded-lg bg-muted/50 border border-border/60">
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase block">Hours Saved</span>
                    <span className="font-bold text-foreground text-sm">{emp.hoursSaved} hrs</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase block">Quality Rate</span>
                    <span className="font-bold text-emerald-600 text-sm">{emp.efficiency}%</span>
                  </div>
                </div>

                {/* Capabilities */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider block">
                    Core Capabilities
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {capabilities.slice(0, 4).map((cap, i) => (
                      <Badge key={i} variant="outline" className="text-[10px] py-0 border-border bg-muted/40 font-normal">
                        {cap}
                      </Badge>
                    ))}
                    {capabilities.length > 4 && (
                      <span className="text-[10px] text-muted-foreground self-center">
                        +{capabilities.length - 4} more
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>

              <CardFooter className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    toggleMutation.mutate({
                      id: emp.id,
                      organizationId: currentOrgId,
                      status: isActive ? "paused" : "active",
                    })
                  }
                  className="text-xs gap-1.5"
                >
                  {isActive ? (
                    <>
                      <Pause className="h-3 w-3" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3" />
                      Resume
                    </>
                  )}
                </Button>

                {isGrantWriter ? (
                  <Button
                    size="sm"
                    onClick={onOpenGrantWriter}
                    className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    <span>Launch Studio</span>
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toast.info(`${emp.name} is running ongoing automated tasks.`)}
                    className="text-xs text-muted-foreground"
                  >
                    View Log
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      <HireEmployeeModal
        open={isHireModalOpen}
        onOpenChange={setIsHireModalOpen}
        onSuccess={refetch}
      />
    </div>
  );
};
