import React, { useState } from "react";
import { AppLayout, NavTab } from "@/components/AppLayout";
import { DashboardView } from "@/pages/DashboardView";
import { GrantWriterView } from "@/pages/GrantWriterView";
import { AssistantView } from "@/pages/AssistantView";
import { SocialMediaView } from "@/pages/SocialMediaView";
import { BlogWriterView } from "@/pages/BlogWriterView";
import { PublishingChannelsView } from "@/pages/PublishingChannelsView";
import { EmployeesRosterView } from "@/pages/EmployeesRosterView";
import { KnowledgeBaseView } from "@/pages/KnowledgeBaseView";
import { AuditGovernanceView } from "@/pages/AuditGovernanceView";
import { WorkspaceSettingsView } from "@/pages/WorkspaceSettingsView";
import { HireEmployeeModal } from "@/components/HireEmployeeModal";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";

export default function Home() {
  const [currentTab, setCurrentTab] = useState<NavTab>("dashboard");
  const [isHireModalOpen, setIsHireModalOpen] = useState(false);
  const { currentOrgId } = useTenant();
  const { refetch: refetchEmployees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });

  return (
    <AppLayout currentTab={currentTab} onSelectTab={setCurrentTab}>
      {currentTab === "dashboard" && (
        <DashboardView
          onOpenGrantWriter={() => setCurrentTab("grant-writer")}
          onOpenEmployees={() => setCurrentTab("employees")}
          onOpenKnowledge={() => setCurrentTab("knowledge")}
          onOpenHireModal={() => setIsHireModalOpen(true)}
        />
      )}

      {currentTab === "grant-writer" && <GrantWriterView />}

      {currentTab === "assistant" && <AssistantView />}

      {currentTab === "social" && <SocialMediaView />}

      {currentTab === "blog" && <BlogWriterView />}

      {currentTab === "publishing" && <PublishingChannelsView />}

      {currentTab === "employees" && (
        <EmployeesRosterView
          onOpenGrantWriter={() => setCurrentTab("grant-writer")}
        />
      )}

      {currentTab === "knowledge" && <KnowledgeBaseView />}

      {currentTab === "audit" && <AuditGovernanceView />}

      {currentTab === "settings" && <WorkspaceSettingsView />}

      <HireEmployeeModal
        open={isHireModalOpen}
        onOpenChange={setIsHireModalOpen}
        onSuccess={refetchEmployees}
      />
    </AppLayout>
  );
}
