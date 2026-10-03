import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

export type Outputs = inferRouterOutputs<AppRouter>;
export type OppRow = Outputs["opps"]["list"][number];
export type AppRow = Outputs["applications"]["list"][number];
export type AppDetail = Outputs["applications"]["get"];

export type Requirements = {
  due?: string;
  questions?: { text: string; limit: string; maxWords: number }[];
  narrativeLimit?: string;
  format?: string;
  scoring?: { name: string; points: number }[];
  attachments?: { name: string; required: boolean; needsSignature: boolean }[];
  eligibility?: string;
  aiPolicy?: { restricted: boolean; note: string; citation: string };
  channel?: string;
  channelDetail?: string;
  submitWhat?: string;
  eventDate?: string;
  decisionDate?: string;
  videoRequired?: boolean;
  videoLimit?: string;
  deckLimit?: string;
  pages?: Record<string, string>;
  questionsDue?: string;
  questionsTo?: string;
  contact?: { name: string; title: string; phone: string; email: string };
  terms?: { label: string; value: string }[];
};

export type Question = {
  id: string;
  text: string;
  limit: string;
  maxWords: number;
  answer: string;
  outline: string[];
  facts: { text: string; source: string }[];
  sources: string[];
  status: string;
};

export type Attachment = {
  name: string;
  source: "brain" | "made" | "missing" | "upload" | "host_form";
  required: boolean;
  needsSignature: boolean;
  fileUrl: string | null;
  knowledgeId: number | null;
  content: string | null;
};

export type Extras = { deck?: { title: string; bullets: string[] }[]; videoScript?: string; videoUrl?: string | null; videoName?: string | null; financials?: string };

export type Review = {
  score: number;
  total: number;
  criteria: { name: string; points: number; max: number; note: string }[];
  fixes: { id: string; text: string; kind: string; questionId: string; done: boolean }[];
  passed: string[];
  checkedAt: string;
};

export type Award = {
  amount: string;
  period: string;
  restrictions: string;
  letterUrl: string | null;
  spent: number;
  total: number;
  reports: { name: string; due: string; status: "not_due" | "drafting" | "ready" | "sent"; draft: string }[];
};
