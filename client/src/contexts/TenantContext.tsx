import React, { createContext, useContext, useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";

export interface Organization {
  id: number;
  name: string;
  slug: string;
  plan: "starter" | "growth" | "enterprise";
  /** business, nonprofit or healthcare: decides the roster, the titles and the client information rules. */
  orgType?: "business" | "nonprofit" | "healthcare";
  focusAreas: string | null;
  ein: string | null;
  annualBudget: string | null;
  website: string | null;
  state: string | null;
  logoUrl: string | null;
  timezone?: string;
  /** The person whose device the time zone follows (it changes when they travel); null is a fixed time zone. */
  timezoneFollowUserId?: number | null;
  description?: string | null;
  audience?: string | null;
  entity?: string | null;
  brandColors?: string | null;
  fonts?: string | null;
  setupAt?: Date | string | null;
  /** Quiet: the employees do nothing on their own and answer only when messaged. */
  quiet?: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Only a guest on shared Projects lists here. */
  guest?: boolean;
  /** This person's role in the workspace: owner, admin, member, chat (team chat only) or reviewer. */
  role?: string;
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
  /** True when this person is team chat only here: channels, direct messages, the Team page and their account, nothing else. */
  chatOnly: boolean;
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

  // The device's time zone goes to the account when the app opens and whenever it comes back into
  // view, so after a flight the times and every workspace that follows this device catch up.
  const deviceZone = trpc.auth.deviceZone.useMutation({
    onSuccess: (r) => {
      if (r.changed.length) void refetch();
    },
  });
  const sentZone = React.useRef<string | null>(null);
  useEffect(() => {
    const report = () => {
      if (document.visibilityState === "hidden") return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz || tz === sentZone.current) return;
      sentZone.current = tz;
      deviceZone.mutate({ timezone: tz });
    };
    report();
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    const t = window.setInterval(report, 10 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        chatOnly: (currentOrg as Organization | null)?.role === "chat",
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
