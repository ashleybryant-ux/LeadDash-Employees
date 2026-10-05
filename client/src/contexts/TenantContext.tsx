import React, { createContext, useContext, useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";

export interface Organization {
  id: number;
  name: string;
  slug: string;
  plan: "starter" | "growth" | "enterprise";
  focusAreas: string | null;
  ein: string | null;
  annualBudget: string | null;
  website: string | null;
  state: string | null;
  logoUrl: string | null;
  timezone?: string;
  description?: string | null;
  audience?: string | null;
  entity?: string | null;
  brandColors?: string | null;
  fonts?: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Only a guest on shared Projects lists here. */
  guest?: boolean;
}

interface TenantContextType {
  currentOrgId: number;
  currentOrg: Organization | null;
  organizations: Organization[];
  isLoading: boolean;
  switchOrganization: (orgId: number) => void;
  openCreateOrgModal: () => void;
  closeCreateOrgModal: () => void;
  isCreateOrgModalOpen: boolean;
  refetchOrgs: () => void;
}

const TenantContext = createContext<TenantContextType | undefined>(undefined);

const STORAGE_KEY = "leaddash_employees_active_org_id";

export const TenantProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data: orgs, isLoading, refetch } = trpc.organizations.list.useQuery();
  const [currentOrgId, setCurrentOrgId] = useState<number>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? parseInt(saved, 10) : 1;
  });
  const [isCreateOrgModalOpen, setIsCreateOrgModalOpen] = useState(false);

  // Synchronize default org when list loads
  useEffect(() => {
    if (orgs && orgs.length > 0) {
      const exists = orgs.some((o) => o.id === currentOrgId);
      if (!exists && orgs[0]) {
        setCurrentOrgId(orgs[0].id);
        localStorage.setItem(STORAGE_KEY, orgs[0].id.toString());
      }
    }
  }, [orgs, currentOrgId]);

  const switchOrganization = (orgId: number) => {
    setCurrentOrgId(orgId);
    localStorage.setItem(STORAGE_KEY, orgId.toString());
  };

  const currentOrg = orgs?.find((o) => o.id === currentOrgId) || null;

  return (
    <TenantContext.Provider
      value={{
        currentOrgId,
        currentOrg: currentOrg as Organization | null,
        organizations: (orgs as Organization[]) || [],
        isLoading,
        switchOrganization,
        openCreateOrgModal: () => setIsCreateOrgModalOpen(true),
        closeCreateOrgModal: () => setIsCreateOrgModalOpen(false),
        isCreateOrgModalOpen,
        refetchOrgs: refetch,
      }}
    >
      {children}
    </TenantContext.Provider>
  );
};

export const useTenant = () => {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenant must be used within a TenantProvider");
  }
  return context;
};
