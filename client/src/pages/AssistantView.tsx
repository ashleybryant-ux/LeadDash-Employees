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
  Mail,
  Calendar,
  Send,
  Clock,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ShieldCheck,
  UserCheck,
  RefreshCw,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

export const AssistantView: React.FC = () => {
  const { currentOrgId, currentOrg } = useTenant();
  const [activeSubTab, setActiveSubTab] = useState<"inbox_drafts" | "calendar_holds" | "compose">("inbox_drafts");

  // Form states
  const [subject, setSubject] = useState("");
  const [recipient, setRecipient] = useState("");
  const [context, setContext] = useState("");
  const [desiredOutcome, setDesiredOutcome] = useState("");

  const [calTitle, setCalTitle] = useState("");
  const [calDate, setCalDate] = useState("2026-10-12");
  const [calTime, setCalTime] = useState("10:00 AM MT");
  const [calAttendees, setCalAttendees] = useState("dr.vance@apexbehavioral.org, sarah.chen@apexbehavioral.org");
  const [calAgenda, setCalAgenda] = useState("Quarterly clinical intake turnaround & peer navigator capacity review.");

  const { data: employees } = trpc.employees.list.useQuery({ organizationId: currentOrgId });
  const avery = employees?.find((e) => e.name.toLowerCase().includes("avery") || e.roleTitle.toLowerCase().includes("assistant"));

  const { data: queueItems, refetch: refetchQueue } = trpc.assistant.listItems.useQuery({ organizationId: currentOrgId });

  const draftEmailMutation = trpc.assistant.draftEmailReply.useMutation({
    onSuccess: () => {
      toast.success("Avery Cole prepared the email draft and staged it for approval!");
      setSubject("");
      setRecipient("");
      setContext("");
      setDesiredOutcome("");
      setActiveSubTab("inbox_drafts");
      refetchQueue();
    },
    onError: (err) => {
      toast.error("Failed to draft email: " + err.message);
    },
  });

  const scheduleHoldMutation = trpc.assistant.scheduleAppointmentHold.useMutation({
    onSuccess: () => {
      toast.success("Avery Cole staged the calendar appointment hold for approval!");
      setCalTitle("");
      setCalAgenda("");
      setActiveSubTab("calendar_holds");
      refetchQueue();
    },
    onError: (err) => {
      toast.error("Failed to schedule hold: " + err.message);
    },
  });

  const approveMutation = trpc.publishing.approveAndDispatch.useMutation({
    onSuccess: (res) => {
      toast.success(`Action approved! Status: ${res?.status}`);
      refetchQueue();
    },
    onError: (err) => {
      toast.error("Failed to approve item: " + err.message);
    },
  });

  const emailDrafts = queueItems?.filter((i) => i.kind === "email_draft") || [];
  const calendarHolds = queueItems?.filter((i) => i.kind === "calendar_hold") || [];

  return (
    <div className="space-y-6">
      {/* Avery Cole Profile Header */}
      <div className="rounded-xl border border-primary/30 bg-card p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <EmployeeAvatar
              name={avery?.name || "Avery Cole"}
              avatar={avery?.avatar}
              status="active"
              showStatus
              className="h-16 w-16"
            />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-foreground">
                  {avery?.name || "Avery Cole"}
                </h1>
                <Badge className="bg-emerald-600 text-white text-[10px] px-2 py-0.5">
                  EXECUTIVE ASSISTANT
                </Badge>
              </div>
              <p className="text-xs text-primary font-medium">{avery?.roleTitle || "Executive Operations & Scheduling Lead"}</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
                Drafts executive inbox correspondence, coordinates clinic leadership calendars, and stages every transmission for human verification.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-muted/60 border border-border px-3 py-2 rounded-lg text-xs">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <div>
              <span className="font-semibold block text-foreground">Zero Auto-Send Guarantee</span>
              <span className="text-[11px] text-muted-foreground">Drafts queued for human approval</span>
            </div>
          </div>
        </div>

        {/* Sub-tab Navigation */}
        <div className="flex items-center gap-2 mt-5 border-t border-border/60 pt-4 overflow-x-auto">
          <Button
            variant={activeSubTab === "inbox_drafts" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("inbox_drafts")}
            className="text-xs gap-1.5"
          >
            <Mail className="h-3.5 w-3.5" />
            Email Responses ({emailDrafts.length})
          </Button>
          <Button
            variant={activeSubTab === "calendar_holds" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("calendar_holds")}
            className="text-xs gap-1.5"
          >
            <Calendar className="h-3.5 w-3.5" />
            Calendar Holds ({calendarHolds.length})
          </Button>
          <Button
            variant={activeSubTab === "compose" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("compose")}
            className="text-xs gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Instruct Avery (Compose / Schedule)
          </Button>
        </div>
      </div>

      {/* Tab: Email Responses */}
      {activeSubTab === "inbox_drafts" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Executive Email Drafts Queue
            </h2>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Workspace: {currentOrg?.name}
            </Badge>
          </div>

          {emailDrafts.length === 0 ? (
            <Card className="p-8 text-center border-dashed">
              <Mail className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm font-semibold text-foreground">No pending email drafts</p>
              <p className="text-xs text-muted-foreground mt-1">
                Instruct Avery to respond to an executive email or inquiry.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {emailDrafts.map((draft) => {
                let metadata: any = {};
                try {
                  metadata = draft.metadata ? JSON.parse(draft.metadata) : {};
                } catch (e) {}

                const isPending = draft.status === "pending_approval";
                const isPublished = draft.status === "published";

                return (
                  <Card key={draft.id} className="border border-border/80 shadow-xs">
                    <CardHeader className="pb-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-base font-bold">{draft.title}</CardTitle>
                            <Badge
                              className={`text-[10px] ${
                                isPending
                                  ? "bg-amber-500 text-white"
                                  : isPublished
                                  ? "bg-emerald-600 text-white"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {draft.status.replace("_", " ").toUpperCase()}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            To: <strong className="text-foreground">{metadata.recipient || "Executive Contact"}</strong> · Target: Google Workspace Draft
                          </p>
                        </div>

                        {draft.externalReference && (
                          <span className="text-[11px] font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground">
                            {draft.externalReference}
                          </span>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="pb-3">
                      <div className="p-4 rounded-lg bg-muted/40 border border-border/60 text-xs font-sans whitespace-pre-wrap leading-relaxed text-foreground">
                        {draft.body}
                      </div>
                    </CardContent>

                    <CardFooter className="pt-2 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[11px] text-muted-foreground">
                        {draft.approvedBy ? `Approved by ${draft.approvedBy}` : "Requires executive confirmation"}
                      </div>

                      {isPending && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId: currentOrgId,
                                itemId: draft.id,
                                action: "request_revisions",
                                reviewerName: "Dr. Marcus Vance",
                              })
                            }
                            className="text-xs"
                          >
                            Request Revisions
                          </Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId: currentOrgId,
                                itemId: draft.id,
                                action: "approve_for_dispatch",
                                reviewerName: "Dr. Marcus Vance",
                              })
                            }
                            className="text-xs bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
                          >
                            <Send className="h-3 w-3" />
                            Approve for Gmail Dispatch
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

      {/* Tab: Calendar Holds */}
      {activeSubTab === "calendar_holds" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Staged Calendar Holds & Appointments
            </h2>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Google Calendar Connected
            </Badge>
          </div>

          {calendarHolds.length === 0 ? (
            <Card className="p-8 text-center border-dashed">
              <Calendar className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm font-semibold text-foreground">No pending calendar holds</p>
              <p className="text-xs text-muted-foreground mt-1">
                Avery will stage calendar appointment holds based on incoming invitations.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {calendarHolds.map((hold) => {
                let metadata: any = {};
                try {
                  metadata = hold.metadata ? JSON.parse(hold.metadata) : {};
                } catch (e) {}

                const isPending = hold.status === "pending_approval";

                return (
                  <Card key={hold.id} className="border border-border/80 shadow-xs flex flex-col justify-between">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-base font-bold">{hold.title}</CardTitle>
                          <p className="text-xs text-primary font-medium mt-1">
                            {metadata.date} at {metadata.time}
                          </p>
                        </div>
                        <Badge
                          className={`text-[10px] ${
                            isPending ? "bg-amber-500 text-white" : "bg-emerald-600 text-white"
                          }`}
                        >
                          {hold.status.replace("_", " ").toUpperCase()}
                        </Badge>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3 pb-3">
                      <div className="p-3 rounded-lg bg-muted/40 border border-border/60 text-xs font-sans whitespace-pre-wrap leading-relaxed text-foreground">
                        {hold.body}
                      </div>

                      {metadata.attendees && (
                        <div className="space-y-1">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase">
                            Proposed Attendees:
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {Array.isArray(metadata.attendees)
                              ? metadata.attendees.map((att: string, i: number) => (
                                  <Badge key={i} variant="outline" className="text-[10px]">
                                    {att}
                                  </Badge>
                                ))
                              : <span className="text-xs">{metadata.attendees}</span>}
                          </div>
                        </div>
                      )}
                    </CardContent>

                    <CardFooter className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {hold.approvedBy ? `Confirmed by ${hold.approvedBy}` : "Awaiting confirmation"}
                      </span>

                      {isPending && (
                        <Button
                          size="sm"
                          onClick={() =>
                            approveMutation.mutate({
                                organizationId: currentOrgId,
                                itemId: hold.id,
                                action: "approve_for_dispatch",
                                reviewerName: "Dr. Marcus Vance",
                              })
                            }
                          className="text-xs bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          Approve Calendar Event
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

      {/* Tab: Instruct Avery */}
      {activeSubTab === "compose" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Email Draft Composer */}
          <Card className="border border-border">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-primary" />
                <CardTitle className="text-base font-bold">Draft Executive Email Reply</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Avery will synthesize a professional response grounded in your clinical organization context.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Email Subject / Thread</label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Partnership Proposal: Regional Crisis Stabilization Network"
                  className="text-xs"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Recipient Email</label>
                <Input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="e.g. director@partnerclinic.org"
                  className="text-xs"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Incoming Email Context / Points to Cover</label>
                <Textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="Paste incoming email or describe key commitments, timeline, and dates..."
                  className="text-xs min-h-[90px]"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Desired Outcome / Tone</label>
                <Input
                  value={desiredOutcome}
                  onChange={(e) => setDesiredOutcome(e.target.value)}
                  placeholder="e.g. Confirm virtual briefing for Thursday at 10 AM, request attendee count"
                  className="text-xs"
                />
              </div>
            </CardContent>

            <CardFooter className="pt-2 border-t border-border flex justify-end">
              <Button
                disabled={draftEmailMutation.isPending || !subject || !recipient || !context}
                onClick={() =>
                  draftEmailMutation.mutate({
                    organizationId: currentOrgId,
                    subject,
                    recipient,
                    context,
                    desiredOutcome,
                  })
                }
                className="text-xs bg-primary text-primary-foreground gap-1.5"
              >
                {draftEmailMutation.isPending ? (
                  <>
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Avery is Drafting...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3" />
                    Generate & Stage Email Draft
                  </>
                )}
              </Button>
            </CardFooter>
          </Card>

          {/* Calendar Hold Composer */}
          <Card className="border border-border">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-primary" />
                <CardTitle className="text-base font-bold">Stage Calendar Appointment Hold</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Avery will draft a calendar invite and verify attendee time zones before scheduling.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Meeting / Hold Title</label>
                <Input
                  value={calTitle}
                  onChange={(e) => setCalTitle(e.target.value)}
                  placeholder="e.g. Strategic Peer Navigator Capacity Planning"
                  className="text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-semibold text-foreground block mb-1">Date</label>
                  <Input
                    type="date"
                    value={calDate}
                    onChange={(e) => setCalDate(e.target.value)}
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-foreground block mb-1">Time</label>
                  <Input
                    value={calTime}
                    onChange={(e) => setCalTime(e.target.value)}
                    placeholder="10:00 AM MT"
                    className="text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Attendees (Comma separated)</label>
                <Input
                  value={calAttendees}
                  onChange={(e) => setCalAttendees(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Meeting Agenda & Location</label>
                <Textarea
                  value={calAgenda}
                  onChange={(e) => setCalAgenda(e.target.value)}
                  placeholder="Agenda items, video conference link, and pre-read materials..."
                  className="text-xs min-h-[90px]"
                />
              </div>
            </CardContent>

            <CardFooter className="pt-2 border-t border-border flex justify-end">
              <Button
                disabled={scheduleHoldMutation.isPending || !calTitle || !calAgenda}
                onClick={() =>
                  scheduleHoldMutation.mutate({
                    organizationId: currentOrgId,
                    title: calTitle,
                    date: calDate,
                    time: calTime,
                    attendees: calAttendees,
                    agenda: calAgenda,
                  })
                }
                className="text-xs bg-primary text-primary-foreground gap-1.5"
              >
                {scheduleHoldMutation.isPending ? (
                  <>
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Avery is Scheduling...
                  </>
                ) : (
                  <>
                    <Calendar className="h-3 w-3" />
                    Stage Calendar Hold
                  </>
                )}
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
};
